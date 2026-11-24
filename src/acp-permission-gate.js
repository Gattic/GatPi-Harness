"use strict";

/**
 * Pi's authority gate for Antigravity ACP tool calls.
 *
 * The ACP server asks Pi before it edits a file or runs a command. This module
 * answers that request from Pi's policy: the same `.pi/policy-gate/policy.json`
 * rules, the same approval store and the same mode that gate Pi's own tool
 * calls. Requests the policy cannot judge (unknown ACP tool kinds, or a known
 * kind without a path or command) need an explicit grant, and an interactive
 * approval is offered through the shared desktop/phone surfaces.
 */

const path = require("node:path");

const { FileApprovalStore } = require("./policy-enforcement");
const {
  decideAcpPermission,
  acpPermissionResponse,
  formatAcpPermissionDecision,
} = require("./acp-permission-policy");
const { policyMode } = require("./policy-mode");
const { requestApproval } = require("./policy-approval");
const { readJson } = require("./pi-extension-kit");

const GATE_STATE_DIR = path.join(".pi", "policy-gate");

/** The local policy file shared with the policy-gate/policy-enforcer surfaces. */
function gatePolicy(cwd) {
  return readJson(path.join(cwd, GATE_STATE_DIR, "policy.json"), {}) || {};
}

/**
 * @param {object} options
 * @param {string} options.cwd session working directory (the ACP session cwd)
 * @param {object} [options.pi] extension API, used to reach the paired-phone approval channel
 * @param {() => object|undefined} [options.getContext] returns the live extension context
 * @param {object} [options.policy] policy override (defaults to the project policy file)
 * @param {string} [options.mode] mode override (defaults to the shared policy mode)
 * @param {object} [options.approvalStore] approval store override
 * @param {(decision: object) => void} [options.onDecision] observer for decisions, used by tests and telemetry
 */
function createAcpPermissionGate(options = {}) {
  const cwd = options.cwd || process.cwd();
  const store = options.approvalStore || new FileApprovalStore({ cwd });
  const onDecision = options.onDecision;

  function decide(request) {
    return decideAcpPermission(request, {
      cwd,
      policy: options.policy || gatePolicy(cwd),
      mode: options.mode || policyMode(),
      approvalStore: store,
    });
  }

  function report(decision, ctx) {
    if (onDecision) onDecision(decision);
    // An allowed call is routine; a denial must say why, or the model's own
    // "denied by pre-tool hook" wording is the only explanation the user sees.
    if (!decision.allow && ctx?.ui?.notify) {
      ctx.ui.notify(formatAcpPermissionDecision(decision), "warning");
    }
  }

  return {
    cwd,
    store,
    decide,
    /** Answer one ACP `session/request_permission` request. */
    async request(request) {
      let decision = decide(request);
      const ctx = options.getContext ? options.getContext() : undefined;
      if (!decision.allow && decision.action === "approval-required" && options.pi && ctx?.hasUI) {
        const approved = await requestApproval(options.pi, ctx, decision, {
          title: "Antigravity ACP tool approval",
          format: formatAcpPermissionDecision,
        });
        if (approved) {
          for (const item of decision.missingApprovals || []) {
            store.approve(item.request, { reason: "interactive ACP approval" });
          }
          decision = decide(request);
        }
      }
      report(decision, ctx);
      return acpPermissionResponse(request, decision);
    },
  };
}

module.exports = { GATE_STATE_DIR, gatePolicy, createAcpPermissionGate };
