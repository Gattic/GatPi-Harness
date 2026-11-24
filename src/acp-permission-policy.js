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
 * Only requests the server actually raises are visible here. Tool calls the
 * server's own policy auto-approves never reach this module.
 */

const { enforceToolCall, evaluateToolCall } = require("./policy-enforcement");
const { policyMode } = require("./policy-mode");

/** Antigravity's `execute` tool call carries a shell command line. */
const EXECUTE_KINDS = new Set(["execute", "execute_command", "run_command", "terminal", "command"]);
/** Anything that changes the workspace is judged as a Pi write. */
const WRITE_KINDS = new Set(["edit", "write", "create", "delete", "move", "rename", "patch", "apply_patch"]);
/** Reads carry a path but never need a write grant. */
const READ_KINDS = new Set(["read", "list", "search", "glob", "grep"]);

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
 * `unmapped` marks a request Pi cannot judge by path or command: an unknown
 * tool kind, or a known kind whose path/command is missing. Those need an
 * explicit grant instead of a silent allow.
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
      : { kind, toolName: `acp_${kind || "execute"}`, input: { ...rawInput }, unmapped: true };
  }
  if (WRITE_KINDS.has(kind)) {
    return path
      ? { kind, toolName: kind === "edit" ? "edit" : "write", input: { path }, unmapped: false }
      : { kind, toolName: `acp_${kind}`, input: { ...rawInput }, unmapped: true };
  }
  if (READ_KINDS.has(kind)) {
    return path
      ? { kind, toolName: "read", input: { path }, unmapped: false }
      : { kind, toolName: `acp_${kind}`, input: { ...rawInput }, unmapped: true };
  }
  return { kind, toolName: `acp_${kind || "tool"}`, input: { ...rawInput }, unmapped: true };
}

function optionList(options) {
  return Array.isArray(options) ? options : [];
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
 * Known kinds run through the policy enforcer's own `enforceToolCall`, so
 * approvals (`/policy-approve`, `/policy-approve-directory`) and the configured
 * mode behave exactly as they do for Pi tools.
 */
function decideAcpPermission(permission, options = {}) {
  const toolCall = permission?.toolCall || permission || {};
  const mapped = acpToolRequest(toolCall);
  const cwd = options.cwd || process.cwd();
  const policy = options.policy || {};
  const mode = options.mode || policyMode();
  const approvalStore = options.approvalStore;

  let decision;
  if (mapped.unmapped) {
    const evaluated = evaluateToolCall(mapped.toolName, mapped.input, { cwd, policy });
    const missing = evaluated.evaluations.filter((item) => !approvalStore?.has?.(item.key));
    decision = {
      allow: missing.length === 0,
      action: missing.length ? "approval-required" : "approved",
      mode,
      severity: missing.length ? "warn" : "allow",
      toolName: mapped.toolName,
      input: mapped.input,
      acpKind: mapped.kind,
      requests: evaluated.requests,
      evaluations: evaluated.evaluations,
      denied: [],
      warnings: [],
      reasons: missing.length
        ? [`ACP tool ${mapped.toolName} has no path or command to judge; approve it explicitly`]
        : [`ACP tool ${mapped.toolName} is approved`],
      missingApprovals: missing.map((item) => ({
        key: item.key,
        request: item.request,
        reasons: item.decision.reasons,
      })),
    };
  } else {
    decision = {
      ...enforceToolCall(mapped.toolName, mapped.input, { cwd, policy, mode, approvalStore }),
      toolName: mapped.toolName,
      input: mapped.input,
      acpKind: mapped.kind,
    };
  }

  const persistentApproved = allApproved(decision, approvalStore);
  return {
    ...decision,
    acpKind: mapped.kind,
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
  acpToolRequest,
  selectOption,
  decideAcpPermission,
  acpPermissionResponse,
  formatAcpPermissionDecision,
};
