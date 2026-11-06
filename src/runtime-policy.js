"use strict";

const path = require("node:path");

const { DEFAULT_DENY_SHELL, DEFAULT_WARN_SHELL, evaluateShellCommand } = require("./shell-policy");
const DEFAULT_ALLOW_TOOLS = [
  "read", "bash", "edit", "write", "grep", "find", "ls",
  "verification_center", "runtime_doctor", "session_stabilizer",
  "privacy_guard", "memory_explorer", "project_profiler", "test_gap_planner", "memory_curator",
  "policy_gate", "performance_optimizer", "ci_pr_companion", "create_subagent", "run_topology",
  "skill_synthesis", "project_intelligence", "evidence_binder", "extension_ops",
  "output_compactor", "policy_enforcer", "learning_loop", "automation_loop",
];
const DEFAULT_DENY_PATH_PREFIXES = ["/etc", "/usr", "/bin", "/sbin", "/var", process.env.HOME ? `${process.env.HOME}/.ssh` : "~/.ssh"];

function normalizePolicy(policy = {}) {
  return {
    denyShell: policy.denyShell || DEFAULT_DENY_SHELL,
    warnShell: policy.warnShell || DEFAULT_WARN_SHELL,
    allowTools: policy.allowTools || DEFAULT_ALLOW_TOOLS,
    denyPathPrefixes: policy.denyPathPrefixes || DEFAULT_DENY_PATH_PREFIXES,
    requireApprovalFor: policy.requireApprovalFor || ["package-install", "outside-repo-write", "secret-bearing-trace", "unapproved-skill", "unsafe-topology"],
  };
}
function serializablePolicy(policy = {}) {
  const p = normalizePolicy(policy);
  return { ...p, denyShell: p.denyShell.map(String), warnShell: p.warnShell.map(String) };
}
function classifyRequest(input = {}) {
  if (typeof input === "string") return { command: input };
  return {
    command: input.command || input.cmd || input.shell || input.nextPrompt,
    path: input.path || input.file || input.filePath,
    tool: input.tool || input.toolName || input.name,
    kind: input.kind || input.operation,
    raw: input,
  };
}
function normalizePathValue(value) {
  if (typeof value !== "string") return value;
  let out = value.replace(/^@/, "");
  // Only expand the current user's home shorthand.  Do not interpret
  // ~otheruser/...; Node has no cross-platform user-home resolver for that.
  if (out === "~") return process.env.HOME || out;
  if (out.startsWith("~/")) return process.env.HOME ? path.join(process.env.HOME, out.slice(2)) : out;
  return out;
}
function resolveMaybeHome(value) { return normalizePathValue(String(value || "")); }
function isWithinPath(target, base) {
  const relative = path.relative(base, target);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function samePatternList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => String(value) === String(b[index]));
}
function evaluatePolicy(input, { cwd = process.cwd(), policy = {}, mode = "advisory" } = {}) {
  const p = normalizePolicy(policy);
  const x = classifyRequest(input);
  const reasons = [];
  const denialCodes = [];
  let severity = "allow";
  function warn(reason) { if (severity !== "deny") severity = "warn"; reasons.push(reason); }
  function deny(code, reason) { severity = "deny"; denialCodes.push(code); reasons.push(reason); }
  if (x.tool && !(p.allowTools || []).includes(x.tool)) warn(`tool not explicitly allowlisted: ${x.tool}`);
  if (x.command) {
    const shell = evaluateShellCommand(x.command, {
      cwd,
      denyPathPrefixes: p.denyPathPrefixes,
      customDenyShell: samePatternList(p.denyShell, DEFAULT_DENY_SHELL) ? [] : p.denyShell,
      customWarnShell: samePatternList(p.warnShell, DEFAULT_WARN_SHELL) ? [] : p.warnShell,
    });
    for (const item of shell.denials) deny(item.code, item.reason);
    for (const item of shell.warnings) warn(item.reason);
  }
  if (x.path) {
    const normalizedPath = normalizePathValue(x.path);
    const abs = path.resolve(cwd, normalizedPath);
    const repo = path.resolve(cwd);
    const writeLike = /write|edit|modify|create|delete|apply|patch/i.test(String(x.kind || "")) || ["edit", "write", "ast_refactor"].includes(String(x.tool || ""));
    if (writeLike && !isWithinPath(abs, repo)) deny("outside-repo-write", `write-like path outside repo: ${x.path}`);
    for (const prefix of p.denyPathPrefixes || []) {
      const resolvedPrefix = path.resolve(resolveMaybeHome(prefix));
      if (isWithinPath(abs, resolvedPrefix)) deny("denied-path", `denied path prefix: ${prefix}`);
    }
  }
  if (/PI_TRACE_CAPTURE_PAYLOADS\s*=\s*1|capturePayloads["']?\s*:\s*true/i.test(JSON.stringify(input || {}))) warn("secret-bearing trace payload capture should be explicitly approved");
  return { ok: severity !== "deny", enforce: mode === "enforce", severity, denialCodes, reasons: reasons.length ? reasons : ["no policy violations detected"], input: x.raw || input };
}
function assertPolicyAllowed(input, options = {}) {
  const result = evaluatePolicy(input, options);
  if (!result.ok) {
    const error = new Error(`policy denied: ${result.reasons.join("; ")}`);
    error.policy = result;
    throw error;
  }
  return result;
}

module.exports = { DEFAULT_DENY_SHELL, DEFAULT_WARN_SHELL, DEFAULT_ALLOW_TOOLS, DEFAULT_DENY_PATH_PREFIXES, normalizePathValue, normalizePolicy, serializablePolicy, classifyRequest, evaluatePolicy, assertPolicyAllowed };
