"use strict";

/**
 * Map Antigravity ACP permission requests onto Pi's own policy decisions.
 *
 * The ACP server executes its tools inside its runtime and asks the client
 * (`session/request_permission`) before it edits a file or runs a command. Pi
 * answers those requests from its own policy instead of approving blindly or
 * cancelling everything: the same shell parsing, path rules, approval store and
 * mode that gate Pi tool calls decide what the ACP agent may do.
 *
 * The gate never asks a person mid-stream. A Pi dialog cannot render while the
 * assistant turn is still streaming and the server is waiting for its answer,
 * so a prompt there deadlocks the turn. Conforming calls are approved from
 * policy, violations are refused with their approval key, and the person grants
 * the key with `/policy-approve` (or the policy_enforcer tool) when they accept
 * the risk.
 *
 * Only requests the server actually raises are visible here. Tool calls the
 * server's own policy auto-approves never reach this module.
 */

const { enforceToolCall } = require("./policy-enforcement");
const { policyMode } = require("./policy-mode");

/** Antigravity's `execute` tool call carries a shell command line. */
const EXECUTE_KINDS = new Set(["execute", "execute_command", "run_command", "terminal", "command"]);
/** Anything that changes the workspace is judged as a Pi write. */
const WRITE_KINDS = new Set(["edit", "write", "create", "delete", "move", "rename", "patch", "apply_patch"]);
/** Reads carry a path but never need a write grant. */
const READ_KINDS = new Set(["read", "list", "search", "glob", "grep"]);
/** Kinds the server uses to ask the person something instead of requesting a call. */
const QUESTION_KINDS = new Set(["ask", "ask_user", "question", "elicit", "plan", "confirm"]);
/** Kinds that are actions Pi judges even when they carry no command or path. */
const ACTION_KINDS = new Set([
  ...EXECUTE_KINDS,
  ...WRITE_KINDS,
  ...READ_KINDS,
  "fetch",
  "http",
  "download",
  "upload",
  "web",
  "browser",
  "mcp",
]);
/** A workspace-trust prompt: Pi's own trust decision answers it. */
const TRUST_PATTERN = /\b(trust|trusted|workspace trust)\b/iu;
/** Titles that read as a question for the person rather than a call to judge. */
const QUESTION_PATTERN = /\?\s*$|\b(plan|question|confirm|proceed|approve)\b/iu;

// The server spells raw input keys differently per build and mode
// (`CommandLine`/`command_line`, `TargetFile`/`file_path`), so look them up
// case- and separator-insensitively rather than by exact name.
const COMMAND_KEYS = ["commandline", "command", "cmd", "commandlinetext", "shellcommand"];
const PATH_KEYS = ["targetfile", "filepath", "path", "absolutepath", "targetpath", "target", "file", "filename"];

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/gu, "");
}

function field(rawInput, keys) {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const normalized = new Map(Object.entries(rawInput).map(([key, value]) => [normalizeKey(key), value]));
  for (const key of keys) {
    const value = normalized.get(key);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Translate one ACP tool call into the Pi tool call Pi's policy understands.
 *
 * `missing` marks an execute/write request whose command or path Pi cannot see.
 * Those are refused rather than approved, because there is no request shape to
 * judge or to grant. Unknown kinds are judged like an unknown Pi tool: policy
 * decides, and a tool allowlist miss is only an advisory warning.
 */
function acpToolRequest(toolCall = {}) {
  const kind = String(toolCall?.kind || "other").trim().toLowerCase();
  const rawInput = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
  const title = typeof toolCall?.title === "string" ? toolCall.title : undefined;
  const command = field(rawInput, COMMAND_KEYS) || (EXECUTE_KINDS.has(kind) ? title : undefined);
  const path = field(rawInput, PATH_KEYS);

  if (EXECUTE_KINDS.has(kind)) {
    return command
      ? { kind, toolName: "bash", input: { command }, unmapped: false }
      : { kind, toolName: `acp_${kind}`, input: { ...rawInput }, unmapped: true, missing: "command" };
  }
  if (WRITE_KINDS.has(kind)) {
    return path
      ? { kind, toolName: kind === "edit" ? "edit" : "write", input: { path }, unmapped: false }
      : { kind, toolName: `acp_${kind}`, input: { ...rawInput }, unmapped: true, missing: "path" };
  }
  if (READ_KINDS.has(kind)) {
    return path
      ? { kind, toolName: "read", input: { path }, unmapped: false }
      : { kind, toolName: "read", input: {}, unmapped: false };
  }
  return { kind, toolName: `acp_${kind || "tool"}`, input: { ...rawInput }, unmapped: false };
}

function optionList(options) {
  return Array.isArray(options) ? options : [];
}

/** Every string the server put in the call, so a question reads as one line. */
function questionText(toolCall = {}) {
  const rawInput = toolCall?.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {};
  const parts = [];
  if (typeof toolCall?.title === "string" && toolCall.title.trim()) parts.push(toolCall.title.trim());
  for (const value of Object.values(rawInput)) {
    if (typeof value === "string" && value.trim()) parts.push(value.trim());
  }
  return [...new Set(parts)].join(" — ").slice(0, 4000);
}

/**
 * Whether a request is a question for the person rather than permission for an
 * action. Pi can only judge calls: it has a command or a path, and its policy
 * decides. A question has neither, so answering it with the first allow option
 * would decide something only the person can.
 */
function acpQuestion(request) {
  const toolCall = request?.toolCall || request || {};
  const mapped = acpToolRequest(toolCall);
  // A call Pi can judge is a permission request, not a question.
  if (mapped.missing) return undefined;
  if (["bash", "write", "edit"].includes(mapped.toolName)) return undefined;
  if (mapped.toolName === "read" && mapped.input.path) return undefined;
  const text = questionText(toolCall);
  if (!text) return undefined;
  const kind = String(toolCall?.kind || "other").trim().toLowerCase();
  const options = optionList(request?.options);
  const trust = TRUST_PATTERN.test(text);
  const asks = QUESTION_KINDS.has(kind) || trust || (!ACTION_KINDS.has(kind) && QUESTION_PATTERN.test(text));
  if (!asks) return undefined;
  return {
    text,
    kind,
    trust,
    options: options.map((option) => ({
      id: String(option?.optionId ?? ""),
      name: String(option?.name ?? option?.optionId ?? ""),
    })),
  };
}

/**
 * Pi grants a single request, never a standing grant in the server's own store:
 * a persistent server-side approval would let later calls bypass Pi's policy.
 * `allow_always` is therefore only acceptable when Pi already holds the grant.
 */
function selectOption(options, decision, { persistentApproved = false } = {}) {
  const list = optionList(options);
  const byId = (id) => list.find((option) => option?.optionId === id);
  const byKind = (kind) => list.find((option) => option?.kind === kind);
  if (decision?.allow) {
    const once = byId("allow") || byKind("allow_once");
    if (once) return once.optionId;
    const always = byId("allow_always") || byKind("allow_always");
    return persistentApproved && always ? always.optionId : undefined;
  }
  const deny = byId("deny") || byKind("reject_once") || byId("reject_always") || byKind("reject_always");
  return deny?.optionId;
}

function allApproved(decision, approvalStore) {
  const evaluations = decision?.evaluations || [];
  if (!evaluations.length) return false;
  return evaluations.every((item) => approvalStore?.has?.(item.key));
}

/**
 * Decide one ACP permission request.
 *
 * Calls run through the policy enforcer's own `enforceToolCall`, so approvals
 * (`/policy-approve`, `/policy-approve-directory`) and the configured mode
 * behave exactly as they do for Pi tools: a conforming call is approved, a
 * violation is refused with the approval key that would allow it.
 */
function decideAcpPermission(permission, options = {}) {
  const toolCall = permission?.toolCall || permission || {};
  const mapped = acpToolRequest(toolCall);
  const cwd = options.cwd || process.cwd();
  const policy = options.policy || {};
  const mode = options.mode || policyMode();
  const approvalStore = options.approvalStore;

  const question = acpQuestion(permission);
  if (question) {
    // Pi answers a trust prompt from its own trust decision. Every other
    // question is one only the person can answer, so it is declined and shown
    // in the transcript; picking an option here would decide it for them.
    const trusted = options.projectTrusted === true;
    // Pi grants one request, never a standing server-side trust, because the
    // server's own approvals would then bypass this gate.
    const optionId = trusted && question.trust ? selectOption(permission?.options, { allow: true }) : undefined;
    const answered = optionId !== undefined;
    return {
      allow: answered,
      action: answered ? "allow" : "ask",
      mode,
      severity: answered ? "allow" : "deny",
      toolName: `acp_${question.kind}`,
      input: {},
      acpKind: question.kind,
      question,
      requests: [],
      evaluations: [],
      denied: [],
      warnings: [],
      reasons: [
        question.trust
          ? !trusted
            ? "the workspace is not trusted in Pi"
            : answered
              ? "the workspace is trusted in Pi"
              : "the workspace is trusted in Pi, but the server offers only a standing grant"
          : "the server asked a question Pi cannot answer while the turn streams",
      ],
      missingApprovals: [],
      optionId,
    };
  }

  const decision = mapped.missing
    ? {
        allow: false,
        action: "block",
        mode,
        severity: "deny",
        toolName: mapped.toolName,
        input: mapped.input,
        acpKind: mapped.kind,
        requests: [],
        evaluations: [],
        denied: [],
        warnings: [],
        reasons: [`ACP ${mapped.kind} request carries no ${mapped.missing}; Pi cannot judge it`],
        missingApprovals: [],
      }
    : {
        ...enforceToolCall(mapped.toolName, mapped.input, { cwd, policy, mode, approvalStore }),
        toolName: mapped.toolName,
        input: mapped.input,
        acpKind: mapped.kind,
      };

  const persistentApproved = allApproved(decision, approvalStore);
  return {
    ...decision,
    acpKind: mapped.kind,
    // Keep one decision shape for callers: an allowed call has no missing approvals.
    missingApprovals: decision.missingApprovals ?? [],
    optionId: selectOption(permission?.options, decision, { persistentApproved }),
  };
}

/** Build the ACP JSON-RPC response for a decision. */
function acpPermissionResponse(permission, decision) {
  const optionId = decision?.optionId;
  return optionId
    ? { outcome: { outcome: "selected", optionId } }
    : { outcome: { outcome: "cancelled" } };
}

function formatAcpPermissionDecision(decision) {
  const lines = [
    `acp-permission ${decision?.action || "deny"} ${decision?.toolName || "request"}`,
    `kind: ${decision?.acpKind || "unknown"}`,
    `mode: ${decision?.mode || policyMode()}`,
  ];
  if (decision?.input?.command) lines.push(`command: ${decision.input.command}`);
  if (decision?.input?.path) lines.push(`path: ${decision.input.path}`);
  if (decision?.question) {
    lines.push(`question: ${decision.question.text}`);
    if (decision.question.options.length) {
      lines.push("options:", ...decision.question.options.map((option) => `- ${option.id} ${option.name}`));
    }
  }
  if (decision?.reasons?.length) lines.push("reasons:", ...decision.reasons.map((reason) => `- ${reason}`));
  if (decision?.missingApprovals?.length) {
    lines.push("approval keys:", ...decision.missingApprovals.map((item) => `- ${item.key} ${JSON.stringify(item.request)}`));
  }
  return lines.join("\n");
}

module.exports = {
  EXECUTE_KINDS,
  WRITE_KINDS,
  READ_KINDS,
  QUESTION_KINDS,
  acpToolRequest,
  acpQuestion,
  selectOption,
  decideAcpPermission,
  acpPermissionResponse,
  formatAcpPermissionDecision,
};
