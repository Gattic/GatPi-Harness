import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolve, relative, isAbsolute, dirname, basename, sep } from "node:path";
import { accessSync, lstatSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SpecialistToolsAdapter } = require("../../src/integration-boundary.js");
const specialistTools = new SpecialistToolsAdapter();

const MAX_DIAGNOSTIC_CHARS = 4000;
const FINAL_SUBMISSION_CALL_RESERVE = 1;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const CLEAN_VERIFICATION_ENV = [
  "PI_ROLE_SIDECAR=",
  "PI_ROLE_CONTRACT_B64=",
  "PI_ROLE_EXPECTED_MODEL=",
  "PI_ROLE_EXPECTED_THINKING_LEVEL=",
  "PI_SUBAGENT_PARENT_ID=",
  "PI_SUBAGENT_RPC_DEPTH=",
];
function verificationCommand(executable: string, args: string[], timeoutMs: number) {
  return { executable: "env", args: [...CLEAN_VERIFICATION_ENV, executable, ...args], timeoutMs };
}
const ROLE_VERIFY_COMMANDS: Record<string, { executable: string; args: string[]; timeoutMs: number }> = {
  "git-diff-check": verificationCommand("git", ["diff", "--check"], 30_000),
  "git-status": verificationCommand("git", ["status", "--short"], 30_000),
  "harness-integration-boundary": verificationCommand("bash", ["scripts/check-integration-boundary.sh"], 120_000),
  "parallel-evidence-benchmark": verificationCommand("node", ["tests/parallel-evidence-benchmark.test.js"], 120_000),
  "check-all": verificationCommand("bash", ["scripts/check-all.sh"], 480_000),
};

type RoleContract = {
  schemaVersion: number;
  contractVersion: string;
  roleId: string;
  settings?: { containment?: string; domainOperations?: string[]; domainInput?: unknown; taskPolicy?: { readZones: string[]; writeZones: string[]; storageBytes?: number } };
  workspacePolicy: "handler-only" | "shared-readonly" | "isolated-worktree";
  mutationPolicy: "forbidden" | "proposed-patch" | "isolated-only";
  toolPolicy: { allowedTools: string[]; deniedTools: string[] };
  modelPolicy: {
    mode: "inherit" | "preferred" | "fixed";
    preference: string | null;
    fallback: "inherit" | string;
    thinkingLevel: "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  };
  budget: { maxModelCalls: number; maxToolCalls: number; maxResultChars: number } | null;
  outputSchema: { type: "object"; required?: string[]; properties: Record<string, any> };
  completionPolicy: { allowEmptySummary: boolean; minimumSummaryChars: number; rejectedSummaries: string[]; requireEvidence: boolean; requireVerificationVerdict: boolean };
};

function decodeContract(): RoleContract {
  const encoded = process.env.PI_ROLE_CONTRACT_B64 || "";
  if (!encoded) throw new Error("PI role sidecar requires PI_ROLE_CONTRACT_B64");
  let value: any;
  try { value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")); }
  catch { throw new Error("PI role sidecar contract is malformed"); }
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 2 || value.contractVersion !== "role-v2" || !value.roleId) throw new Error("PI role sidecar requires a role-v2 contract");
  if (!["handler-only", "shared-readonly", "isolated-worktree"].includes(value.workspacePolicy) || !["forbidden", "proposed-patch", "isolated-only"].includes(value.mutationPolicy)) throw new Error("PI role sidecar contract has an invalid workspace or mutation policy");
  if (!Array.isArray(value?.toolPolicy?.allowedTools) || !Array.isArray(value?.toolPolicy?.deniedTools)) throw new Error("PI role sidecar requires an explicit tool policy");
  if (!value?.modelPolicy || !["inherit", "preferred", "fixed"].includes(value.modelPolicy.mode) || !["inherit", ...THINKING_LEVELS].includes(value.modelPolicy.thinkingLevel)) throw new Error("PI role sidecar requires an explicit model and thinking policy");
  const allowed = value.toolPolicy.allowedTools.map(String);
  const denied = value.toolPolicy.deniedTools.map(String);
  const conflicts = allowed.filter((name: string) => denied.includes(name));
  if (conflicts.length) throw new Error(`PI role sidecar contract both allows and denies: ${conflicts.join(", ")}`);
  if (value.budget !== null) for (const name of ["maxModelCalls", "maxToolCalls", "maxResultChars"]) {
    const amount = Number(value?.budget?.[name]);
    if (!Number.isFinite(amount) || amount < 0) throw new Error(`PI role sidecar contract has invalid budget ${name}`);
  }
  if (value.budget !== null && Number(value.budget.maxModelCalls) < 3) throw new Error("PI role sidecar requires at least three model calls so initial submission and final correction calls remain reserved");
  if (value?.outputSchema?.type !== "object" || !value.outputSchema.properties || typeof value.outputSchema.properties !== "object" || Array.isArray(value.outputSchema.properties)) throw new Error("PI role sidecar requires a complete output schema");
  if (!value?.completionPolicy || !Number.isInteger(Number(value.completionPolicy.minimumSummaryChars)) || Number(value.completionPolicy.minimumSummaryChars) < 0 || !Array.isArray(value.completionPolicy.rejectedSummaries)) throw new Error("PI role sidecar requires a meaningful completion policy");
  for (const field of ["requireEvidence", "requireVerificationVerdict"]) if (typeof value.completionPolicy[field] !== "boolean") throw new Error(`PI role sidecar completion policy ${field} must be boolean`);
  value.completionPolicy.minimumSummaryChars = Number(value.completionPolicy.minimumSummaryChars);
  value.completionPolicy.rejectedSummaries = [...new Set(value.completionPolicy.rejectedSummaries.map((item: any) => String(item).trim().toLowerCase()).filter(Boolean))];
  value.toolPolicy = { allowedTools: [...new Set(allowed)], deniedTools: [...new Set(denied)] };
  return value as RoleContract;
}

function bounded(value: unknown, max = MAX_DIAGNOSTIC_CHARS) { const text = String(value || ""); return text.length > max ? `${text.slice(0, max)}…` : text; }
function canonicalPath(file: string): string {
  const missing: string[] = [];
  let ancestor = file;
  // New files can have missing parent directories. Resolve the nearest existing
  // ancestor, but never treat a dangling symlink as a missing directory.
  while (!lstatSync(ancestor, { throwIfNoEntry: false })) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error("path has no existing ancestor");
    missing.unshift(basename(ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}
function safePath(root: string, input: any, allowedPrivateReadPaths: string[] = [], restrictReadPaths = false, taskZones?: string[], requireExisting = false) {
  const privateAllowlist = new Set(allowedPrivateReadPaths.map((value) => resolve(root, String(value))));
  const candidates = [input?.path, input?.file, input?.filePath, input?.directory, input?.cwd].filter((value) => typeof value === "string");
  if (taskZones && !candidates.length) candidates.push(".");
  try {
    const canonicalRoot = realpathSync(root);
    for (const candidate of candidates) {
      const spelling = String(candidate).replace(/^@/, "");
      // Require literal filesystem paths: SDK expansion/normalization must not
      // select a different target after this authorization check.
      if (/^~(?:[/\\]|$)|^file:\/\/|[\u00a0\u2000-\u200a\u202f\u205f\u3000]/.test(spelling)) return false;
      const absolute = resolve(root, spelling);
      // The SDK read tool tries alternate filenames only when this path is absent.
      if (requireExisting) accessSync(absolute);
      const canonical = canonicalPath(absolute);
      const canonicalGrant = resolve(root, relative(canonicalRoot, canonical));
      const privateAllowed = privateAllowlist.has(absolute) && privateAllowlist.has(canonicalGrant);
      if (restrictReadPaths && !privateAllowed) return false;
      // Both the requested spelling and its actual target must be authorized.
      // An alias cannot widen an exact private grant or a task's read/write zones.
      for (const [base, target] of [[resolve(root), absolute], [canonicalRoot, canonical]]) {
        const rel = relative(base, target).split(sep).join("/");
        if (rel === ".." || rel.startsWith("../") || isAbsolute(rel)) return false;
        const parts = rel.split("/");
        if (parts.includes(".git") || (parts.includes(".pi") && !privateAllowed)) return false;
        if (taskZones) {
          if (!taskZones.some(zone => rel === zone.replace(/\/$/, "") || (zone.endsWith("/") && rel.startsWith(zone)))) return false;
          if (parts.some(part => /^(?:\.env(?:\..*)?|.*(?:credential|secret|password|private[-_.]?key).*)$/i.test(part))) return false;
        }
      }
    }
  } catch { return false; }
  return true;
}
function normalizeVerificationStatus(status: any) {
  const value = String(status || "unchecked").trim().toLowerCase().replace(/_/g, "-");
  return ["not-run", "not-checked", "unverified"].includes(value) ? "unchecked" : value;
}
function publicSubmission(params: any) {
  const roadmapPlan = params?.roadmapPlan && typeof params.roadmapPlan === "object" && !Array.isArray(params.roadmapPlan)
    ? {
        title: String(params.roadmapPlan.title || "").trim(),
        milestones: Array.isArray(params.roadmapPlan.milestones) ? params.roadmapPlan.milestones.map((milestone: any) => ({
          title: String(milestone?.title || "").trim(),
          goals: Array.isArray(milestone?.goals) ? milestone.goals.map((goal: any) => String(goal || "").trim()) : [],
        })) : [],
      }
    : null;
  const submission: any = {
    summary: String(params?.summary || "").trim(),
    findings: Array.isArray(params?.findings) ? params.findings : [],
    evidence: Array.isArray(params?.evidence) ? params.evidence : [],
    artifacts: Array.isArray(params?.artifacts) ? params.artifacts : [],
    proposedPatch: params?.proposedPatch ?? null,
    verification: params?.verification && typeof params.verification === "object"
      ? { status: normalizeVerificationStatus(params.verification.status), evidence: Array.isArray(params.verification.evidence) ? params.verification.evidence : [] }
      : { status: "unchecked", evidence: [] },
    ...(roadmapPlan ? { roadmapPlan } : {}),
  };
  if (params?.analysisPlan && typeof params.analysisPlan === "object" && !Array.isArray(params.analysisPlan)) submission.analysisPlan = params.analysisPlan;
  for (const field of ["claims", "evidenceRefs", "auditDecisions", "disagreements", "rejectedClaims", "unresolvedGaps", "recommendedActions"]) if (Array.isArray(params?.[field])) submission[field] = params[field];
  if (params?.coverage && typeof params.coverage === "object" && !Array.isArray(params.coverage)) submission.coverage = params.coverage;
  for (const field of ["dossier", "visualCritique", "manifestValidation", "filterResult", "sourceReading", "workflow", "objectiveScore", "candidatePackage", "reviewDecision", "auditDecision", "candidate"]) if (params?.[field] && typeof params[field] === "object" && !Array.isArray(params[field])) submission[field] = params[field];
  return submission;
}
function isPlaceholderText(value: unknown, rejectedValues: string[] = []) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return false;
  const rejected = new Set(rejectedValues.map((item) => String(item).trim().toLowerCase()).filter(Boolean));
  return rejected.has(text) || !/[a-z0-9]/i.test(text) || /^(?:placeholder|todo|tbd|n\/a|none|unknown|noop|no-op|fixme|xxx|x)(?:\d+)?$/i.test(text);
}
function hasMeaningfulEvidenceDetail(item: any) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  return Object.entries(item).some(([key, value]) => !["id", "kind", "type"].includes(key) && value != null && (typeof value === "number" || typeof value === "boolean" || (typeof value === "string" && value.trim().length >= 3 && !isPlaceholderText(value)) || (Array.isArray(value) && value.length > 0) || (typeof value === "object" && Object.keys(value).length > 0)));
}
function completionPolicyError(submission: any, policy: RoleContract["completionPolicy"]) {
  const summary = String(submission?.summary || "").trim();
  if (!policy.allowEmptySummary && !summary) return "role result summary must not be empty";
  if (summary.length < Number(policy.minimumSummaryChars || 0)) return `role result summary must contain at least ${policy.minimumSummaryChars} meaningful characters`;
  if (isPlaceholderText(summary, policy.rejectedSummaries)) return "role result summary is a placeholder rather than a meaningful result";
  if (policy.requireEvidence && !submission?.evidence?.length) return "role result requires at least one supporting evidence item";
  if (policy.requireEvidence && !submission.evidence.some(hasMeaningfulEvidenceDetail)) return "role result requires at least one evidence item with supporting detail";
  if (policy.requireVerificationVerdict && !["passed", "failed"].includes(submission?.verification?.status)) return "role result verification.status must be passed or failed";
  if (submission?.roadmapPlan) {
    if (isPlaceholderText(submission.roadmapPlan.title, policy.rejectedSummaries)) return "roadmapPlan title must be meaningful rather than a placeholder";
    for (const milestone of submission.roadmapPlan.milestones || []) {
      if (isPlaceholderText(milestone?.title, policy.rejectedSummaries)) return "roadmapPlan milestone titles must be meaningful rather than placeholders";
      if ((milestone?.goals || []).some((goal: string) => isPlaceholderText(goal, policy.rejectedSummaries))) return "roadmapPlan goals must be meaningful rather than placeholders";
    }
  }
  return null;
}
function completionPolicyInstruction(policy: RoleContract["completionPolicy"]) {
  return [
    `Summary must contain at least ${policy.minimumSummaryChars} meaningful characters and must not be a placeholder.`,
    ...(policy.requireEvidence ? ["Include at least one supporting evidence item."] : []),
    ...(policy.requireVerificationVerdict ? ["Set verification.status to passed or failed."] : []),
    "When ready, call submit_role_result once and never more than once in a response. If validation rejects it, use the next reserved model call to submit one corrected result.",
  ].join(" ");
}
function submissionTransportSchema(schema: RoleContract["outputSchema"]) {
  const transport = JSON.parse(JSON.stringify(schema));
  if (transport?.properties?.summary) delete transport.properties.summary.minLength;
  if (transport?.properties?.evidence) delete transport.properties.evidence.minItems;
  return transport;
}

export default function roleSidecar(pi: ExtensionAPI) {
  if (process.env.PI_ROLE_SIDECAR !== "1") return;
  const contract = decodeContract();
  if (contract.workspacePolicy === "handler-only") throw new Error(`handler-only role ${contract.roleId} cannot launch as a sidecar`);
  const expectedModel = String(process.env.PI_ROLE_EXPECTED_MODEL || "").trim();
  const expectedThinkingLevel = String(process.env.PI_ROLE_EXPECTED_THINKING_LEVEL || "").trim();
  if (!expectedModel || !THINKING_LEVELS.has(expectedThinkingLevel)) throw new Error(`role inference policy invalid for ${contract.roleId}: expected model and thinking level are required`);
  const assertInferencePolicy = (ctx: any) => {
    const effectiveModel = ctx.model?.id ? `${ctx.model.provider}/${ctx.model.id}` : "";
    const effectiveThinkingLevel = String(ctx.thinkingLevel || "");
    if (effectiveModel !== expectedModel || effectiveThinkingLevel !== expectedThinkingLevel) throw new Error(`role inference policy mismatch for ${contract.roleId}: expected ${expectedModel}/${expectedThinkingLevel}, got ${effectiveModel || "unknown"}/${effectiveThinkingLevel || "unknown"}`);
  };
  const subagentId = process.env.PI_SUBAGENT_PARENT_ID || "unknown";
  const toolCallIds = new Set<string>();
  let modelCalls = 0;
  const submissionPhaseAfterModelCalls = contract.budget === null ? Infinity : Math.max(1, Number(contract.budget.maxModelCalls) - FINAL_SUBMISSION_CALL_RESERVE - 1);
  let submissionPhase = false;
  let submissionAttemptModelCall = -1;
  let submissionAccepted = false;
  let toolResults = 0;
  let toolFailures = 0;
  const enterSubmissionPhase = () => {
    if (submissionPhase) return;
    pi.setActiveTools(["submit_role_result"]);
    submissionPhase = true;
  };

  if (contract.settings?.containment === "bwrap" && contract.toolPolicy.allowedTools.includes("bash")) pi.registerTool({
    name: "bash", label: "Contained shell", description: "Run a shell command only inside the isolated workspace, without host home, credentials or network.",
    parameters: Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number()) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const result = await specialistTools.run({ cwd: ctx.cwd, command: "bash", args: ["--noprofile", "--norc", "-c", params.command], writable: true, timeoutMs: Math.min(120000, Number(params.timeout || 120) * 1000), signal });
      if (!result.ok) throw new Error(`Contained shell failed: ${result.termination || result.exitCode}: ${bounded(result.stderr)}`);
      return { content: [{ type: "text", text: bounded(result.stdout, 12000) }], details: { exitCode: result.exitCode, termination: result.termination } };
    },
  });
  pi.registerTool({
    name: "role_domain", label: "Domain tool", description: `Run one contract-authorized domain operation in a networkless sandbox. Allowed operations: ${(contract.settings?.domainOperations || []).join(", ") || "none"}. Diagnostics use only the parent's pinned workload/arguments: GDB backtraces, Valgrind memory/cost profiles, Nsight Systems and runtime-specific profiling where granted. No arbitrary commands or host PID attachment.`,
    parameters: Type.Object({ operation: Type.String(), file: Type.String(), outputs: Type.Optional(Type.Array(Type.String(), { maxItems: 4 })) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const result = await specialistTools.domain({ ...params, cwd: ctx.cwd, contract, signal });
      if (result.diagnosticEvidence) return {
        content: [{ type: "text", text: [JSON.stringify({ ok: result.ok, exitCode: result.exitCode, signal: result.signal, termination: result.termination, evidence: result.diagnosticEvidence }), "stdout:", result.stdout, "stderr:", result.stderr].join("\n") }],
        isError: !result.ok,
        details: result,
      };
      if (!result.ok) throw new Error(`Domain operation failed: ${result.termination || result.exitCode}: ${bounded(result.stderr)}`);
      return { content: [{ type: "text", text: bounded(result.stdout, 12000) }], details: { exitCode: result.exitCode, outputBytes: result.outputBytes } };
    },
  });
  pi.registerTool({
    name: "role_diff",
    label: "Role diff",
    description: "Read the current isolated/shared repository diff without modifying files.",
    parameters: Type.Object({ staged: Type.Optional(Type.Boolean()), path: Type.Optional(Type.String()) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const args = ["diff", "--no-ext-diff", "--binary"];
      if (params.staged) args.push("--cached");
      if (params.path) args.push("--", String(params.path).replace(/^@/, ""));
      const result = await pi.exec("git", args, { cwd: ctx.cwd, signal, timeout: 30000 });
      if (result.code !== 0) throw new Error(`role_diff failed: ${bounded(result.stderr)}`);
      const text = bounded(result.stdout, 12000);
      return { content: [{ type: "text", text: text || "No diff." }], details: { exitCode: result.code, bytes: String(result.stdout || "").length } };
    },
  });

  pi.registerTool({
    name: "role_verify",
    label: "Role verify",
    description: `Run one approved repository verification command; arbitrary shell input is not accepted. Approved command IDs: ${Object.keys(ROLE_VERIFY_COMMANDS).join(", ")}.`,
    parameters: Type.Object({ commandId: Type.Union(Object.keys(ROLE_VERIFY_COMMANDS).map((commandId) => Type.Literal(commandId))) }),
    async execute(_id: string, params: any, signal: AbortSignal | undefined, _update: any, ctx: any) {
      const command = ROLE_VERIFY_COMMANDS[String(params.commandId || "")];
      if (!command) throw new Error(`role_verify command is not approved: ${params.commandId}`);
      const isolated = contract.settings?.containment === "bwrap";
      const contained = isolated ? await specialistTools.run({ cwd: ctx.cwd, command: command.args[CLEAN_VERIFICATION_ENV.length], args: command.args.slice(CLEAN_VERIFICATION_ENV.length + 1), writable: false, signal, timeoutMs: command.timeoutMs }) : null;
      const result = contained ? { code: contained.ok ? 0 : contained.exitCode || 1, stdout: contained.stdout, stderr: contained.stderr } : await pi.exec(command.executable, command.args, { cwd: ctx.cwd, signal, timeout: command.timeoutMs });
      const details = { commandId: params.commandId, exitCode: result.code, stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
      if (result.code !== 0) throw new Error(`role_verify ${params.commandId} failed (exit ${result.code}): ${bounded(result.stderr || result.stdout)}`);
      return { content: [{ type: "text", text: `${params.commandId} passed` }], details };
    },
  });

  pi.registerTool({
    name: "submit_role_result",
    label: "Submit role result",
    description: "Validate and submit the final public role-v2 result. Use this exactly once as the final tool call.",
    parameters: Type.Unsafe<Record<string, any>>(submissionTransportSchema(contract.outputSchema)),
    async execute(_id: string, params: any, _signal: AbortSignal | undefined, _update: any, ctx: any) {
      if (submissionAccepted) throw new Error("role result was already submitted successfully");
      for (const field of contract.outputSchema?.required || []) if (!Object.prototype.hasOwnProperty.call(params || {}, field) || params?.[field] === undefined) throw new Error(`role result missing required field: ${field}`);
      const submission = publicSubmission(params);
      const completionError = completionPolicyError(submission, contract.completionPolicy);
      if (completionError) throw new Error(completionError);
      if (submission.roadmapPlan && (!submission.roadmapPlan.title || submission.roadmapPlan.milestones.some((milestone: any) => !milestone.title || milestone.goals.some((goal: string) => !goal)))) throw new Error("roadmapPlan titles and goals must not be blank");
      const serialized = JSON.stringify(submission);
      const maxResultChars = contract.budget?.maxResultChars ?? 131072;
      if (serialized.length > maxResultChars) throw new Error(`role result exceeds ${maxResultChars} serialized characters`);
      const result = {
        schemaVersion: 2,
        contractVersion: "role-v2",
        subagentId,
        roleId: contract.roleId,
        status: "succeeded",
        termination: { code: "submitted", stopReason: "toolUse", message: "typed role result submitted" },
        ...submission,
        diagnostics: {
          modelCalls,
          toolCalls: toolCallIds.size,
          toolResults,
          toolFailures,
          unmatchedToolCallIds: [],
          queueWaitMs: 0,
          executionDurationMs: 0,
          totalDurationMs: 0,
          budgets: contract.budget,
          workspace: { policy: contract.workspacePolicy, path: contract.workspacePolicy === "isolated-worktree" ? ctx.cwd : null },
          childSessionFile: ctx.sessionManager?.getSessionFile?.() || null,
        },
      };
      submissionAccepted = true;
      return { content: [{ type: "text", text: "Role result submitted." }], details: { result }, terminate: true };
    },
  });

  let toolPolicyActivated = false;
  const activateToolPolicy = () => {
    if (toolPolicyActivated) return;
    // Resolve through the shared contract resolver so a `*` entry (for example
    // mcp__blender__*) expands to the tools actually registered in this child
    // instead of being reported as missing, and gate with the same policy
    // matcher the call hook uses.
    const actual = pi.getAllTools().map((tool: any) => String(tool.name));
    specialistTools.resolveRequiredTools(contract, actual, { throwOnMissing: true });
    const active = actual.filter((name: string) => specialistTools.toolAllowedByPolicy(contract.toolPolicy, name));
    pi.setActiveTools(active);
    toolPolicyActivated = true;
  };

  pi.on("session_start", async (_event: any, ctx: any) => { activateToolPolicy(); assertInferencePolicy(ctx); });

  pi.on("before_agent_start", async (event: any, ctx: any) => {
    activateToolPolicy();
    assertInferencePolicy(ctx);
    return { systemPrompt: `${event.systemPrompt}\n\nActive role-v2 contract ${contract.roleId}. Workspace=${contract.workspacePolicy}; mutation=${contract.mutationPolicy}. ${completionPolicyInstruction(contract.completionPolicy)} Finish only through submit_role_result.` };
  });

  pi.on("before_provider_request", async (event: any, ctx: any) => {
    if (!toolPolicyActivated) {
      ctx.abort();
      throw new Error(`role tool policy was not activated for ${contract.roleId}`);
    }
    try { assertInferencePolicy(ctx); }
    catch (error) { ctx.abort(); throw error; }
    modelCalls += 1;
    if (contract.budget !== null && modelCalls > Number(contract.budget.maxModelCalls)) ctx.abort();
    return event.payload;
  });

  pi.on("turn_end", async () => {
    if (modelCalls >= submissionPhaseAfterModelCalls) enterSubmissionPhase();
  });

  pi.on("tool_call", async (event: any, ctx: any) => {
    const name = String(event.toolName || "");
    const id = String(event.toolCallId || `${name}:${toolCallIds.size}`);
    if (!toolCallIds.has(id)) toolCallIds.add(id);
    if (contract.budget !== null && toolCallIds.size > Number(contract.budget.maxToolCalls)) return { block: true, reason: `role tool-call budget exceeded (${toolCallIds.size} > ${contract.budget.maxToolCalls})` };
    if (submissionPhase && name !== "submit_role_result") return { block: true, reason: "Role inspection budget is closed; submit_role_result now using the evidence already collected." };
    if (name === "submit_role_result") {
      if (submissionAccepted) return { block: true, reason: "role result was already submitted successfully" };
      if (submissionAttemptModelCall === modelCalls) return { block: true, reason: "only one submit_role_result call is allowed per model response; use the reserved next call for a correction" };
      submissionAttemptModelCall = modelCalls;
    }
    if (!specialistTools.toolAllowedByPolicy(contract.toolPolicy, name)) return { block: true, reason: `tool ${name} is not allowed by role ${contract.roleId}` };
    if (contract.workspacePolicy === "shared-readonly" && ["bash", "edit", "write"].includes(name)) return { block: true, reason: `shared-readonly role ${contract.roleId} cannot mutate or execute shell commands` };
    const ownership = contract.settings?.taskPolicy;
    const taskZones = ownership && ["read", "grep", "find", "ls", "edit", "write", "role_domain", "role_diff"].includes(name)
      ? ["edit", "write"].includes(name) ? ownership.writeZones : [...ownership.readZones, ...ownership.writeZones]
      : undefined;
    if (!safePath(ctx.cwd, event.input, Array.isArray((contract as any)?.settings?.allowedPrivateReadPaths) ? (contract as any).settings.allowedPrivateReadPaths : [], (contract as any)?.settings?.restrictReadPaths === true, taskZones, name === "read")) return { block: true, reason: "role tool path is outside its ownership or targets private runtime/Git state" };
    if (ownership && ["edit", "write"].includes(name)) {
      try { specialistTools.guardMutation({ cwd: ctx.cwd, contract, tool: name, input: event.input }); }
      catch (error: any) { return { block: true, reason: error.message }; }
    }
    return undefined;
  });

  pi.on("tool_result", async (event: any) => { toolResults += 1; if (event.isError === true) toolFailures += 1; });
}
