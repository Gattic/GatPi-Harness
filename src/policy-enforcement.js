"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { evaluatePolicy, normalizePathValue, serializablePolicy } = require("./runtime-policy");

function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function nowIso() { return new Date().toISOString(); }
function ensureDir(file) { fs.mkdirSync(path.dirname(file), { recursive: true }); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { ensureDir(file); fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }

function normalizePathArg(value) {
  if (typeof value !== "string") return value;
  return normalizePathValue(value);
}

function toolRequests(toolName, input = {}) {
  const requests = [{ kind: "tool", tool: toolName }];
  if (toolName === "bash" || toolName === "user_bash") {
    const command = input.command || input.text || input.args;
    if (command) requests.push({ kind: "shell", command });
  }
  const addPath = (p, kind = "path") => { if (typeof p === "string" && p.trim()) requests.push({ kind, path: normalizePathArg(p) }); };
  if (toolName === "read") addPath(input.path, "read");
  if (toolName === "write") addPath(input.path, "write");
  if (toolName === "edit") {
    addPath(input.path, "write");
    if (Array.isArray(input.edits)) requests.push({ kind: "edit", path: normalizePathArg(input.path), edits: input.edits.length });
  }
  for (const key of ["path", "file", "filePath", "target", "targetPath"]) addPath(input?.[key], /write|edit|apply|patch/i.test(toolName) ? "write" : "path");
  return dedupeRequests(requests);
}

function dedupeRequests(requests) {
  const seen = new Set();
  const out = [];
  for (const req of requests) {
    const sig = stableStringify(req);
    if (!seen.has(sig)) { seen.add(sig); out.push(req); }
  }
  return out;
}

function approvalKey(request) { return `approval_${hash(request).slice(0, 16)}`; }
function normalizeApprovalRequest(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) return request;
  const normalized = { ...request };
  if (typeof normalized.path === "string") normalized.path = normalizePathArg(normalized.path);
  return normalized;
}

// Resolve new files through their nearest existing directory. Only genuinely
// missing components may be peeled off: dangling links, loops, permission
// errors, and file-as-directory paths must never gain directory authority.
function canonicalWritePath(cwd, value) {
  let current = path.resolve(cwd, normalizePathArg(value));
  const missing = [];
  while (true) {
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code !== "ENOENT" || path.dirname(current) === current) throw error;
      missing.unshift(path.basename(current));
      current = path.dirname(current);
      continue;
    }
    const real = fs.realpathSync(current);
    if (missing.length && !(stat.isDirectory() || (stat.isSymbolicLink() && fs.statSync(real).isDirectory()))) {
      throw new Error(`Not a directory: ${current}`);
    }
    return path.join(real, ...missing);
  }
}

class FileApprovalStore {
  constructor({ cwd = process.cwd(), file = path.join(cwd, ".pi", "policy-enforcer", "approvals.json") } = {}) {
    this.cwd = cwd;
    this.file = file;
  }
  packet() { return readJson(this.file, { version: 1, approvals: [] }); }
  save(packet) { writeJson(this.file, { version: 1, approvals: packet.approvals || [] }); }
  list({ includeExpired = false } = {}) {
    const at = Date.now();
    return (this.packet().approvals || []).filter((item) => includeExpired || !item.expiresAt || Date.parse(item.expiresAt) > at);
  }
  has(key) { return this.list().some((item) => item.key === key); }
  approve(request, options = {}) {
    if (request?.kind === "directory-write") throw new Error("Use /policy-approve-directory to grant directory writes");
    return this.saveApproval(normalizeApprovalRequest(request), options);
  }
  approveDirectory(directory, { reason = "manual directory approval", ttlMs = 0, policy = {} } = {}) {
    if (typeof directory !== "string" || !directory.trim()) throw new Error("Directory path is required");
    const absolute = path.resolve(this.cwd, normalizePathArg(directory));
    const canonical = fs.realpathSync(absolute);
    if (!fs.statSync(canonical).isDirectory()) throw new Error(`Not a directory: ${directory}`);
    // Check both spellings: aliases must not bypass protected path prefixes.
    for (const target of [absolute, canonical]) {
      const decision = evaluatePolicy({ kind: "write", path: target }, { cwd: target, policy });
      if (!decision.ok) throw new Error(decision.reasons.join("; "));
    }
    return this.saveApproval({ kind: "directory-write", sourceRoot: fs.realpathSync(this.cwd), path: canonical }, { reason, ttlMs });
  }
  allowsDirectory(evaluation, { cwd = this.cwd, policy = {} } = {}) {
    const { request, decision } = evaluation;
    // Directory grants waive only the outside-repo-write denial, never a
    // protected path, shell command, tool finding, or other approval warning.
    if (!["write", "edit"].includes(request.kind) || typeof request.path !== "string"
      || decision.denialCodes?.length !== 1 || decision.denialCodes[0] !== "outside-repo-write") return false;
    const grants = this.list().filter((item) => item.request?.kind === "directory-write");
    if (!grants.length) return false;
    try {
      const sourceRoot = fs.realpathSync(cwd);
      const target = canonicalWritePath(cwd, request.path);
      return grants.some(({ request: grant }) => {
        if (grant.sourceRoot !== sourceRoot || typeof grant.path !== "string") return false;
        try {
          // A stored canonical root may not be redirected by replacing it with a link.
          if (fs.realpathSync(grant.path) !== grant.path || !fs.statSync(grant.path).isDirectory()) return false;
          const relative = path.relative(grant.path, target);
          if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
          return evaluatePolicy({ kind: request.kind, path: target }, { cwd: grant.path, policy }).ok;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  }
  saveApproval(normalizedRequest, { reason = "manual approval", ttlMs = 24 * 60 * 60 * 1000, key } = {}) {
    const approvalKeyValue = key || approvalKey(normalizedRequest);
    const packet = this.packet();
    const expiresAt = ttlMs ? new Date(Date.now() + ttlMs).toISOString() : null;
    const item = { key: approvalKeyValue, request: normalizedRequest, reason, approvedAt: nowIso(), expiresAt };
    packet.approvals = [...(packet.approvals || []).filter((x) => x.key !== approvalKeyValue), item];
    this.save(packet);
    return item;
  }
  revoke(key) {
    const packet = this.packet();
    const before = (packet.approvals || []).length;
    packet.approvals = (packet.approvals || []).filter((item) => item.key !== key);
    this.save(packet);
    return { revoked: before - packet.approvals.length, key };
  }
  prune() {
    const packet = this.packet();
    const before = (packet.approvals || []).length;
    packet.approvals = this.list();
    this.save(packet);
    return { pruned: before - packet.approvals.length, remaining: packet.approvals.length };
  }
}

function evaluateToolCall(toolName, input, { cwd = process.cwd(), policy = {} } = {}) {
  const requests = toolRequests(toolName, input);
  const evaluations = requests.map((request) => ({ request, key: approvalKey(request), decision: evaluatePolicy(request, { cwd, policy }) }));
  const denied = evaluations.filter((item) => !item.decision.ok);
  const warnings = evaluations.filter((item) => item.decision.ok && item.decision.severity === "warn");
  const severity = denied.length ? "deny" : warnings.length ? "warn" : "allow";
  return { toolName, input, requests, evaluations, severity, denied, warnings, ok: denied.length === 0 };
}

function isAllowlistOnlyWarning(item) {
  const reasons = item?.decision?.reasons || [];
  return reasons.length > 0 && reasons.every((reason) => /^tool not explicitly allowlisted:/.test(String(reason)));
}
function enforceToolCall(toolName, input, options = {}) {
  const mode = options.mode || "block"; // advisory | warn | block | approval
  const approveWarnings = options.approveWarnings === true;
  const evaluated = evaluateToolCall(toolName, input, options);
  const store = options.approvalStore;
  const deniedWithoutApproval = evaluated.denied.filter((item) => !store?.has?.(item.key) && !store?.allowsDirectory?.(item, options));
  // Active enforcement must not turn the tool allowlist into a blocker for newly
  // loaded extension tools. Unknown tools remain visible as advisory policy-gate
  // warnings, but only deny-level findings require approval by default.
  const approvalWarnings = approveWarnings ? evaluated.warnings : evaluated.warnings.filter((item) => !isAllowlistOnlyWarning(item));
  const warnWithoutApproval = approvalWarnings.filter((item) => !store?.has?.(item.key));
  const rawReasons = evaluated.evaluations.flatMap((item) => item.decision.reasons || []);
  const allReasons = rawReasons.some((reason) => reason !== "no policy violations detected") ? rawReasons.filter((reason) => reason !== "no policy violations detected") : rawReasons;
  const visibleWarnings = evaluated.warnings.filter((item) => !isAllowlistOnlyWarning(item));
  const visibleSeverity = deniedWithoutApproval.length || evaluated.denied.length ? "deny" : visibleWarnings.length ? "warn" : "allow";
  if (mode === "advisory") return { allow: true, action: "allow", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons };
  if (mode === "warn") return { allow: true, action: visibleSeverity === "allow" ? "allow" : "warn", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons };
  if (mode === "approval") {
    if (deniedWithoutApproval.length || warnWithoutApproval.length) return { allow: false, action: "approval-required", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons, missingApprovals: [...deniedWithoutApproval, ...warnWithoutApproval].map((x) => ({ key: x.key, request: x.request, reasons: x.decision.reasons })) };
    return { allow: true, action: visibleSeverity === "allow" ? "allow" : "approved", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons };
  }
  if (deniedWithoutApproval.length) return { allow: false, action: "block", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons, missingApprovals: deniedWithoutApproval.map((x) => ({ key: x.key, request: x.request, reasons: x.decision.reasons })) };
  return { allow: true, action: visibleSeverity === "warn" ? "warn" : evaluated.denied.length ? "approved" : "allow", mode, ...evaluated, severity: visibleSeverity, reasons: allReasons };
}

function formatEnforcementDecision(decision) {
  const lines = [`policy-enforcer ${decision.action} ${decision.toolName || "request"}`, `mode: ${decision.mode}`, `severity: ${decision.severity}`];
  if (decision.reasons?.length) lines.push("reasons:", ...decision.reasons.map((r) => `- ${r}`));
  if (decision.missingApprovals?.length) lines.push("approval keys:", ...decision.missingApprovals.map((item) => `- ${item.key} ${stableStringify(item.request)}`));
  return lines.join("\n");
}

module.exports = {
  FileApprovalStore,
  approvalKey,
  toolRequests,
  evaluateToolCall,
  enforceToolCall,
  formatEnforcementDecision,
  serializablePolicy,
};
