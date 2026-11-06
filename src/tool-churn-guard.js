"use strict";

const crypto = require("node:crypto");

const DEFAULT_THRESHOLDS = Object.freeze({ processPoll: 3, gitCheck: 3, roadmapMutation: 6, policyApproval: 3, identicalFailure: 2 });
const MUTATING_TOOLS = new Set(["edit", "write", "ast_refactor", "commit_plan", "create_subagent", "roadmap_update", "policy_enforcer", "bash"]);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}
function fingerprint(value) { return crypto.createHash("sha256").update(JSON.stringify(stable(value))).digest("hex").slice(0, 16); }
function operationOf(input = {}) { return String(input?.operation || input?.action || "default").trim() || "default"; }
function targetFingerprint(input = {}) { return fingerprint(input?.targetId || input?.runId || input?.jobId || input?.monitorId || "none"); }
function eventTool(event = {}) { return String(event.toolName || event.name || "unknown"); }
function eventInput(event = {}) { return event.input || event.args || {}; }
function bashGitCheck(input = {}) {
  const match = String(input?.command || "").match(/^\s*git\s+(status|diff)\b/i);
  return match ? match[1].toLowerCase() : null;
}

function createToolChurnGuard(options = {}) {
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
  const calls = new Map();
  const failures = new Map();
  const pending = new Map();
  const issued = new Set();
  let mutationEpoch = 0;
  let recommendations = 0;

  const increment = (map, key) => { const count = (map.get(key) || 0) + 1; map.set(key, count); return count; };
  const recommendOnce = (key, data) => {
    if (issued.has(key)) return null;
    issued.add(key);
    recommendations++;
    return { ...data, count: data.count || 0 };
  };

  function observeCall(event = {}) {
    const tool = eventTool(event);
    const input = eventInput(event);
    const operation = operationOf(input);
    const id = String(event.toolCallId || event.id || `${tool}:${pending.size}`);
    const signature = fingerprint({ tool, operation, input });
    let recommendation = null;

    if (["bg_run", "run_deck"].includes(tool) && ["status", "logs", "watch"].includes(operation)) {
      const key = `process:${tool}:${operation}:${targetFingerprint(input)}`;
      const count = increment(calls, key);
      if (count >= thresholds.processPoll) recommendation = recommendOnce(key, {
        reason: "repeated-process-poll",
        tool,
        operation,
        count,
        message: "Repeated process polling detected. Use one point-in-time status call, or attach run_monitor when the user requested periodic notification; do not keep polling in the model loop.",
      });
    } else if (["gitevidence", "gitverify"].includes(tool) || (tool === "bash" && bashGitCheck(input))) {
      const checkKind = tool === "bash" ? `bash-${bashGitCheck(input)}` : tool;
      const key = `git:${mutationEpoch}:${checkKind}`;
      const count = increment(calls, key);
      if (count >= thresholds.gitCheck) recommendation = recommendOnce(key, {
        reason: "repeated-git-check",
        tool,
        operation,
        count,
        message: "Repeated Git readiness checks detected without an intervening mutation. Defer the next check until code changes or final verification materially change the tree.",
      });
    } else if (tool === "roadmap_update" && ["set_status", "active", "report"].includes(operation)) {
      const key = `roadmap:${operation}`;
      const count = increment(calls, key);
      if (count >= thresholds.roadmapMutation) recommendation = recommendOnce(key, {
        reason: "roadmap-status-churn",
        tool,
        operation,
        count,
        message: "Roadmap status churn detected. Batch transitions with itemIds and cascade=true for a finished phase, and record only material phase transitions and verifier-backed completion instead of narrating every small tool step.",
      });
    } else if (tool === "policy_enforcer" && ["approve", "grant", "request"].includes(operation)) {
      const key = `policy:${operation}`;
      const count = increment(calls, key);
      if (count >= thresholds.policyApproval) recommendation = recommendOnce(key, {
        reason: "repeated-policy-approval",
        tool,
        operation,
        count,
        message: "Repeated policy approvals detected. Inspect the current grant and request one narrowly scoped approval instead of retrying equivalent requests.",
      });
    }

    pending.set(id, { tool, operation, signature, mutating: MUTATING_TOOLS.has(tool) && !(tool === "bash" && bashGitCheck(input)), callRecommendation: recommendation });
    return recommendation;
  }

  function observeResult(event = {}) {
    const id = String(event.toolCallId || event.id || "");
    const call = pending.get(id) || { tool: eventTool(event), operation: "default", signature: fingerprint({ tool: eventTool(event), id }), mutating: false, callRecommendation: null };
    pending.delete(id);
    const failed = event.isError === true || Boolean(event.error);
    if (!failed && call.mutating) mutationEpoch++;
    if (call.callRecommendation) return call.callRecommendation;
    if (!failed) return null;
    const key = `failure:${call.signature}`;
    const count = increment(failures, key);
    if (count < thresholds.identicalFailure) return null;
    return recommendOnce(key, {
      reason: "identical-failed-retry",
      tool: call.tool,
      operation: call.operation,
      count,
      message: "This exact tool request has failed repeatedly. Do not retry it unchanged; inspect the validation message, refresh dynamic IDs/roles/paths, or choose the documented next operation.",
    });
  }

  function reset() {
    calls.clear(); failures.clear(); pending.clear(); issued.clear(); mutationEpoch = 0; recommendations = 0;
  }
  function status() {
    return { thresholds, trackedCallKeys: calls.size, trackedFailureKeys: failures.size, pending: pending.size, recommendations, mutationEpoch, privacy: { argumentsPersisted: false, resultBodiesPersisted: false, fingerprintsEphemeral: true } };
  }
  return { observeCall, observeResult, reset, status };
}

module.exports = { DEFAULT_THRESHOLDS, MUTATING_TOOLS, bashGitCheck, createToolChurnGuard, fingerprint, operationOf };
