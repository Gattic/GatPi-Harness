"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { AgentRoleRegistry } = require("../src/multi-agent-topologies");
const { DEFAULT_DELEGATE_MODEL } = require("../src/role-contracts");
const { SubagentRunner, SubagentService } = require("../src/subagents");
const { validateRpcCompletion } = require("../src/subagent-result-validator");
const { validateRoleResultEnvelope, createRoleResultEnvelope } = require("../src/role-result-schemas");
const { tmpFixture } = require("./helpers/tmp-fixture");

const sidecarFile = path.join(__dirname, "..", "extensions", "role-sidecar", "index.ts");
assert(fs.existsSync(sidecarFile), "the explicit role sidecar extension exists");
const source = fs.readFileSync(sidecarFile, "utf8");
assert(source.includes('PI_ROLE_SIDECAR !== "1"'), "the sidecar is a no-op unless explicitly enabled");
assert(source.includes('name: "submit_role_result"'), "the sidecar registers typed result submission");
assert(source.includes("roadmapPlan"), "planner submissions can preserve the bounded public roadmap hierarchy");
for (const field of ["analysisPlan", "claims", "evidenceRefs", "auditDecisions", "rejectedClaims", "unresolvedGaps", "coverage", "sourceReading", "workflow", "candidatePackage", "reviewDecision", "auditDecision"]) assert(source.includes(field), `role sidecar preserves structured evidence field ${field}`);
assert(source.includes("allowedPrivateReadPaths") && source.includes("privateAllowlist.has(absolute)") && source.includes("restrictReadPaths"), "intake readers can access only exact parent-validated source paths and cannot inspect unrelated repository files");
assert(source.includes("submissionTransportSchema(contract.outputSchema)") && source.includes("delete transport.properties.summary.minLength") && source.includes("delete transport.properties.evidence.minItems") && !source.includes("Type.Any()"), "submission transport relaxes only completion minima so every canonical-shaped attempt reaches the per-response gate");
assert(source.includes("terminate: true"), "typed submission terminates the child turn");
assert(source.includes('name: "role_diff"'), "the sidecar provides a real narrow diff tool");
assert(source.includes('name: "role_verify"'), "the sidecar provides an approved verification runner");
assert(source.includes('"parallel-evidence-benchmark"') && source.includes('"check-all"'), "the verifier allowlist exposes the benchmark regression and repository-wide gate by stable command ID");
assert(source.includes("Type.Literal(commandId)") && source.includes("timeout: command.timeoutMs"), "role_verify publishes exact command IDs and enforces command-specific timeouts");
assert(source.includes("CLEAN_VERIFICATION_ENV") && source.includes('"PI_ROLE_SIDECAR="') && source.includes('"PI_SUBAGENT_RPC_DEPTH="'), "approved verification commands do not leak role-sidecar activation or nesting into repository tests");
assert(source.includes('pi.on("tool_call"'), "the child independently enforces tool and path budgets");
assert(source.includes('pi.on("session_start"'), "tool discovery and activation are deferred until the legal session lifecycle");
assert(source.includes('pi.on("before_agent_start"'), "the child rechecks activation and injects the active contract reminder before model execution");
assert(source.includes('pi.on("before_provider_request"') && source.includes("toolPolicyActivated") && source.includes("ctx.abort()"), "the child aborts before provider execution when policy activation or model budget enforcement fails");
assert(source.includes("PI_ROLE_EXPECTED_MODEL") && source.includes("PI_ROLE_EXPECTED_THINKING_LEVEL") && source.includes("assertInferencePolicy(ctx)"), "the child verifies its effective model and thinking level before provider use");
assert(fs.readFileSync(path.join(__dirname, "..", "src", "subagents.js"), "utf8").includes("SUBAGENT_INFERENCE_POLICY_MISMATCH"), "the parent classifies sidecar inference mismatches canonically");
assert(source.includes("FINAL_SUBMISSION_CALL_RESERVE") && source.includes("submissionPhaseAfterModelCalls") && source.includes('pi.on("turn_end"') && source.includes('pi.setActiveTools(["submit_role_result"])'), "every sidecar reserves a final correction call by closing inspection tools before the provider budget");
assert(source.includes("submissionAttemptModelCall") && source.includes("only one submit_role_result call is allowed per model response") && source.includes("submissionAccepted"), "duplicate submissions are blocked atomically within and after a model response");
assert(source.includes("completionPolicyError") && source.includes("placeholder rather than a meaningful result") && source.includes("verification.status must be passed or failed"), "the child rejects placeholder reviewer output and missing verdicts before typed submission");
assert(source.includes("roadmapPlan goals must be meaningful rather than placeholders"), "planner roadmap placeholders are rejected at the child boundary");
assert(source.includes("Object.prototype.hasOwnProperty.call(params || {}, field)"), "required nullable fields count as present instead of being misreported as missing");
assert(source.includes('"not-run", "not-checked", "unverified"') && source.includes('? "unchecked" : value'), "natural no-verification statuses normalize to the role-v2 unchecked status at the sidecar boundary");
assert(source.includes("pi.getAllTools()"), "required tools are resolved against the actual child registry");
assert(source.includes("pi.setActiveTools"), "the resolved allowlist becomes the active child tool set");

const reviewer = new AgentRoleRegistry().get("reviewer");
const runner = new SubagentRunner();
const inferenceEnvNames = ["PI_ROLE_MODEL_REVIEWER", "PI_ROLE_THINKING_REVIEWER"];
const savedInferenceEnv = Object.fromEntries(inferenceEnvNames.map((name) => [name, process.env[name]]));
for (const name of inferenceEnvNames) delete process.env[name];
let launch;
let ephemeralLaunch;
try {
  launch = runner.rpcArgs({
    id: "sub_sidecar",
    role: reviewer.roleId,
    roleContract: reviewer,
    systemPrompt: reviewer.systemPrompt,
    toolPolicy: reviewer.toolPolicy,
    budget: reviewer.budget,
  }, { cwd: process.cwd(), model: { provider: "provider", id: "parent" }, thinkingLevel: "high" });
  ephemeralLaunch = runner.rpcArgs({ id: "sub_intake_ephemeral", role: reviewer.roleId, roleContract: reviewer, systemPrompt: reviewer.systemPrompt, toolPolicy: reviewer.toolPolicy, budget: reviewer.budget }, { cwd: process.cwd(), model: { provider: "provider", id: "parent" }, thinkingLevel: "high", rpc: { noSession: true } });
} finally {
  for (const name of inferenceEnvNames) {
    if (savedInferenceEnv[name] === undefined) delete process.env[name];
    else process.env[name] = savedInferenceEnv[name];
  }
}
assert(launch.args.includes("--no-extensions"));
assert(launch.args.includes("-e") && launch.args.includes(path.resolve(sidecarFile)), "the role sidecar is the only explicit extension");
assert(launch.args.includes("--no-skills"));
assert(launch.args.includes("--no-prompt-templates"));
assert.equal(launch.env.PI_ROLE_SIDECAR, "1");
assert.equal(JSON.parse(Buffer.from(launch.env.PI_ROLE_CONTRACT_B64, "base64url").toString("utf8")).roleId, "reviewer");
assert.equal(launch.env.PI_ROLE_EXPECTED_MODEL, DEFAULT_DELEGATE_MODEL);
assert.equal(launch.env.PI_ROLE_EXPECTED_THINKING_LEVEL, "high");
assert.equal(launch.provenance.selectedModel, DEFAULT_DELEGATE_MODEL);
assert.equal(launch.provenance.fallbackModel, "provider/parent");
assert.equal(launch.provenance.selectedThinkingLevel, "high");
assert.equal(launch.provenance.thinkingPolicySource, "inherit");
assert(launch.args.includes("--thinking") && launch.args.includes("high"));
assert(ephemeralLaunch.args.includes("--no-session") && !ephemeralLaunch.args.includes("--session-dir"), "privacy-sensitive role sidecars can disable child session persistence");

const validEnvelope = {
  schemaVersion: 2,
  contractVersion: "role-v2",
  subagentId: "sub_sidecar",
  roleId: "reviewer",
  status: "succeeded",
  termination: { code: "submitted", stopReason: "toolUse", message: "submitted" },
  summary: "No correctness, security, or regression defects were found.",
  findings: [],
  evidence: [{ kind: "path", path: "src/example.js", summary: "inspected" }],
  artifacts: [],
  proposedPatch: null,
  verification: { status: "passed", evidence: ["Reviewed src/example.js"] },
  diagnostics: { modelCalls: 1, toolCalls: 1, toolResults: 1, toolFailures: 0, unmatchedToolCallIds: [], queueWaitMs: 0, executionDurationMs: 1, totalDurationMs: 1, budgets: reviewer.budget, workspace: { policy: "shared-readonly" }, childSessionFile: null },
};
assert.equal(validateRoleResultEnvelope(validEnvelope, { contract: reviewer }).ok, true);
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, roleId: "coder" }, { contract: reviewer }).ok, false);
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, summary: "" }, { contract: reviewer }).ok, false);
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, summary: "placeholder" }, { contract: reviewer }).ok, false, "placeholder reviewer summaries fail closed");
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, summary: "." }, { contract: reviewer }).ok, false, "punctuation-only reviewer summaries fail closed");
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, summary: "x" }, { contract: reviewer }).ok, false, "one-character reviewer summaries fail closed");
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, evidence: [] }, { contract: reviewer }).ok, false, "successful reviewer results require supporting evidence");
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, verification: { status: "unchecked", evidence: [] } }, { contract: reviewer }).ok, false, "successful reviewer results require an explicit verdict");
assert.equal(validateRoleResultEnvelope({ ...validEnvelope, status: "failed", termination: { code: "submitted", stopReason: "toolUse" } }, { contract: reviewer }).ok, false, "non-success envelopes cannot retain a success termination code");

const messages = [
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit-1", name: "submit_role_result", arguments: {} }] },
  { role: "toolResult", toolCallId: "submit-1", toolName: "submit_role_result", isError: false, details: { result: validEnvelope }, content: [{ type: "text", text: "submitted" }] },
];
const accepted = validateRpcCompletion({ agentEnd: { type: "agent_end", messages }, messages, budget: reviewer.budget, roleContract: reviewer, requireRoleResultV2: true });
assert.equal(accepted.ok, true);
assert.equal(accepted.submittedResult.schemaVersion, 2);
const duplicateMessages = [
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: "submit-a", name: "submit_role_result" }, { type: "toolCall", id: "submit-b", name: "submit_role_result" }] },
  { role: "toolResult", toolCallId: "submit-a", toolName: "submit_role_result", isError: false, details: { result: validEnvelope }, content: [] },
  { role: "toolResult", toolCallId: "submit-b", toolName: "submit_role_result", isError: false, details: { result: validEnvelope }, content: [] },
];
const duplicate = validateRpcCompletion({ agentEnd: { type: "agent_end", messages: duplicateMessages }, messages: duplicateMessages, budget: reviewer.budget, roleContract: reviewer, requireRoleResultV2: true });
assert.equal(duplicate.ok, false, "multiple successful submit_role_result calls never resolve by silently choosing the last one");
assert.equal(duplicate.termination.code, "invalid_result");
assert.equal(duplicate.diagnostics.acceptedResultSubmissions, 2);
const invalid = validateRpcCompletion({ agentEnd: { type: "agent_end", messages }, messages: [messages[0], { ...messages[1], details: { result: { ...validEnvelope, schemaVersion: 1 } } }], budget: reviewer.budget, roleContract: reviewer, requireRoleResultV2: true });
assert.equal(invalid.ok, false);
assert.equal(invalid.termination.code, "invalid_result");

const fixtureInferenceContext = { model: { provider: "test", id: "fixture" }, thinkingLevel: "high" };

(async () => {
  const tmp = tmpFixture("pi-role-result-boundary-");
  const plainService = new SubagentService({ cwd: tmp, runner: new SubagentRunner({ execute: async () => ({ summary: "plain text", final_response: "plain text" }) }) });
  const plain = plainService.createSubagent({ parentSessionId: "sess_plain", role: "reviewer", task: "reject plain role output", roleContract: reviewer });
  const plainResult = await plainService.runSubagent({ subagentId: plain.id, context: fixtureInferenceContext });
  assert.equal(plainResult.status, "failed", "a role-v2 execution cannot succeed through plain assistant text or an injected runner shortcut");
  assert.equal(plainResult.termination.code, "invalid_result");

  const oldFixtureResult = process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT;
  try {
    process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT = "review fixture";
    const fixtureService = new SubagentService({ cwd: tmp });
    const fixtureRecord = fixtureService.createSubagent({ parentSessionId: "sess_fixture_reviewer", role: "reviewer", task: "validate strict fixture result", roleContract: reviewer });
    const fixtureResult = await fixtureService.runSubagent({ subagentId: fixtureRecord.id, context: fixtureInferenceContext });
    assert.equal(fixtureResult.status, "succeeded", "deterministic fixtures satisfy strict reviewer completion contracts");
    assert.equal(fixtureResult.submitted_result?.verification?.status, "passed");
    assert.equal(fixtureResult.submitted_result?.evidence?.length, 1);
    assert.equal(fixtureResult.submitted_result?.roadmapPlan, undefined, "non-planners do not manufacture plans");

    const planner = new AgentRoleRegistry().get("planner");
    planner.outputSchema = { ...planner.outputSchema, required: [...planner.outputSchema.required, "roadmapPlan"] };
    const planRecord = fixtureService.createSubagent({ parentSessionId: "sess_fixture_planner", role: "planner", task: "plan a deterministic topology fixture", roleContract: planner });
    const planResult = await fixtureService.runSubagent({ subagentId: planRecord.id, context: fixtureInferenceContext });
    assert.equal(planResult.status, "succeeded", "planner fixtures satisfy executable topology roadmapPlan contracts");
    assert.equal(validateRoleResultEnvelope(planResult.submitted_result, { contract: planner }).ok, true);
    assert.equal(planResult.submitted_result.roadmapPlan.milestones.length, 1);
    const missingPlan = { ...planResult.submitted_result };
    delete missingPlan.roadmapPlan;
    assert.equal(validateRoleResultEnvelope(missingPlan, { contract: planner }).ok, false, "missing roadmapPlan remains a runtime validation failure");

    const coder = new AgentRoleRegistry().get("coder");
    await assert.rejects(() => new SubagentRunner().run({ roleContract: coder }, { cwd: tmp, parentCwd: tmp, workspace: { policy: "isolated-worktree" } }), /leased isolated workspace/);
    assert.equal(fs.existsSync(path.join(tmp, "subagent-fixture.txt")), false, "fixture never writes in the parent");
    const project = tmpFixture("pi-coder-fixture-");
    try {
      const git = (args) => execFileSync("git", args, { cwd: project, stdio: "pipe" });
      fs.writeFileSync(path.join(project, "README.md"), "Owned coder fixture.\n");
      fs.writeFileSync(path.join(project, ".gitignore"), ".pi/\n");
      git(["init", "-q"]); git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "fixture"]);
      const service = new SubagentService({ cwd: project });
      const record = service.createSubagent({ parentSessionId: "sess_fixture_coder", role: "coder", task: "produce a deterministic proposed patch", roleContract: coder });
      const result = await service.runSubagent({ subagentId: record.id, context: fixtureInferenceContext });
      assert.equal(result.status, "succeeded");
      assert.deepEqual(result.diagnostics.workspace.changedPaths.map(entry => typeof entry === "string" ? entry : entry.path), ["subagent-fixture.txt"]);
      assert(result.diagnostics.workspace.patchBytes > 0, "coder fixture must produce a captured artifact rather than a no-op claim");
      assert.equal(fs.existsSync(path.join(project, "subagent-fixture.txt")), false);
      assert.equal(git(["status", "--porcelain"]).toString(), "", "parent working tree is untouched");
    } finally {
      fs.rmSync(project, { recursive: true, force: true });
    }
  } finally {
    if (oldFixtureResult === undefined) delete process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT;
    else process.env.PI_SUBAGENT_EXECUTION_FIXTURE_RESULT = oldFixtureResult;
  }

  for (const [status, terminationCode] of [["failed", "provider_error"], ["timed_out", "wall_clock"], ["cancelled", "cancelled"]]) {
    const traceEvents = [];
    const reportedService = new SubagentService({ cwd: tmp, trace: { emit: (event) => traceEvents.push(event) }, runner: new SubagentRunner({ execute: async ({ record }) => {
      const submitted = createRoleResultEnvelope({ contract: reviewer, subagentId: record.id, status, termination: { code: terminationCode, stopReason: status === "cancelled" ? "aborted" : null, message: `${status} fixture` }, submission: { summary: `Reviewer execution ended with explicit ${status} status before completion.`, findings: [], evidence: [{ kind: "runtime", summary: `${status} fixture` }], artifacts: [], proposedPatch: null, verification: { status: "failed", evidence: [`runtime ${status}`] } } });
      return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
    } }) });
    const reported = reportedService.createSubagent({ parentSessionId: `sess_reported_${status}`, role: "reviewer", task: `preserve ${status} typed status`, roleContract: reviewer });
    const reportedResult = await reportedService.runSubagent({ subagentId: reported.id, context: fixtureInferenceContext });
    assert.equal(reportedResult.status, status);
    assert.equal(reportedResult.termination.code, terminationCode);
    assert.equal(reportedService.store.getResult(reported.id).status, status, "the durable envelope retains the child status");
    const terminalTrace = traceEvents.find((event) => event.name === `subagent.${status === "timed_out" ? "timed_out" : status === "cancelled" ? "cancelled" : "failed"}`);
    assert.equal(terminalTrace?.payload?.status, status);
    assert.equal(terminalTrace?.payload?.termination?.code, terminationCode, "trace metadata uses the same canonical termination code");
  }

  let typedExecutionMode;
  let typedThinkingLevel;
  const typedService = new SubagentService({ cwd: tmp, runner: new SubagentRunner({ execute: async ({ record, context }) => {
    typedExecutionMode = context.executionMode;
    typedThinkingLevel = context.thinkingLevel;
    const submitted = createRoleResultEnvelope({ contract: reviewer, subagentId: record.id, submission: { summary: "Review completed with no correctness or regression defects found.", findings: [], evidence: [{ kind: "path", path: "src/example.js", summary: "inspected" }], artifacts: [], proposedPatch: null, verification: { status: "passed", evidence: ["Reviewed src/example.js"] } } });
    return { summary: submitted.summary, final_response: submitted.summary, submitted_result: submitted, termination: submitted.termination };
  } }) });
  const typed = typedService.createSubagent({ parentSessionId: "sess_typed", role: "reviewer", task: "accept typed role output", roleContract: reviewer });
  const typedResult = await typedService.runSubagent({ subagentId: typed.id, context: { ...fixtureInferenceContext, executionMode: "tool-rpc" } });
  assert.equal(typedResult.status, "succeeded");
  assert.equal(typedExecutionMode, "tool-rpc", "role-v2 contracts use the single canonical typed sidecar mode");
  assert.equal(typedThinkingLevel, "high");
  assert.equal(typedResult.schemaVersion, 2);
  assert.equal(typedResult.submitted_result?.summary, "Review completed with no correctness or regression defects found.", "durable role results retain the bounded typed submission for custom topology schemas");
  console.log("role sidecar tests passed");
})().catch((error) => { console.error(error); process.exitCode = 1; });
