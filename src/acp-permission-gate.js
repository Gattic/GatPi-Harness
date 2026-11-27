"use strict";

/**
 * Pi's authority gate for Antigravity ACP tool calls.
 *
 * The ACP server asks Pi before it edits a file or runs a command. This module
 * answers that request from Pi's policy: the same `.pi/policy-gate/policy.json`
 * rules, the same approval store and the same mode that gate Pi's own tool
 * calls. A conforming call is approved without involving a person; a violation
 * is refused, and the notification carries the approval key so
 * `/policy-approve <key>` grants it when the person accepts the risk.
 *
 * The answer is never blocked on a dialog. Pi cannot render one while the
 * assistant turn is streaming and the server is waiting for this response, so
 * an interactive prompt here deadlocks the turn until the ACP prompt timeout.
 *
 * `enforce` applies the same decision to a call Pi executes itself, which is how
 * the ACP file callbacks stay under Pi's policy.
 */

const path = require("node:path");

const { FileApprovalStore, enforceToolCall } = require("./policy-enforcement");
const {
  decideAcpPermission,
  acpPermissionResponse,
  formatAcpPermissionDecision,
} = require("./acp-permission-policy");
const { policyMode } = require("./policy-mode");
const { readJson } = require("./pi-extension-kit");

const GATE_STATE_DIR = path.join(".pi", "policy-gate");

/** The local policy file shared with the policy-gate/policy-enforcer surfaces. */
function gatePolicy(cwd) {
  return readJson(path.join(cwd, GATE_STATE_DIR, "policy.json"), {}) || {};
}

/**
 * @param {object} options
 * @param {string} options.cwd session working directory (the ACP session cwd)
 * @param {() => object|undefined} [options.getContext] returns the live extension context for notifications
 * @param {object} [options.policy] policy override (defaults to the project policy file)
 * @param {string} [options.mode] mode override (defaults to the shared policy mode)
 * @param {object} [options.approvalStore] approval store override
 * @param {(decision: object) => void} [options.onDecision] observer for decisions, used by tests and telemetry
 */
function createAcpPermissionGate(options = {}) {
  const cwd = options.cwd || process.cwd();
  const store = options.approvalStore || new FileApprovalStore({ cwd });
  const onDecision = options.onDecision;

  function currentPolicy() {
    return options.policy || gatePolicy(cwd);
  }

  function currentMode() {
    return options.mode || policyMode();
  }

  function decide(request) {
    return decideAcpPermission(request, {
      cwd,
      policy: currentPolicy(),
      mode: currentMode(),
      approvalStore: store,
      projectTrusted: Boolean(options.getContext?.()?.isProjectTrusted?.()),
    });
  }

  function report(decision, ctx) {
    if (onDecision) onDecision(decision);
    // An allowed call is routine. A refusal must say why and how to accept it,
    // or the server's own "denied by pre-tool hook" wording is the only thing
    // the user sees.
    if (decision.allow || !ctx?.ui?.notify) return;
    const keys = (decision.missingApprovals || []).map((item) => item.key);
    const hint = keys.length ? `\nApprove once with: /policy-approve ${keys[0]}` : "";
    ctx.ui.notify(`${formatAcpPermissionDecision(decision)}${hint}`, "warning");
  }

  return {
    cwd,
    store,
    decide,
    /**
     * Decide a call Pi is about to execute itself, such as an ACP file callback,
     * with the same policy, approval store and mode as its own tool calls. A
     * refusal is reported here, because no permission request preceded it.
     */
    enforce(toolName, input) {
      const decision = {
        ...enforceToolCall(toolName, input, {
          cwd,
          policy: currentPolicy(),
          mode: currentMode(),
          approvalStore: store,
        }),
        toolName,
        input,
      };
      report(decision, options.getContext ? options.getContext() : undefined);
      return decision;
    },
    /**
     * Answer one ACP `session/request_permission` request immediately, and
     * report a question the server asked instead of a call Pi could judge.
     */
    async request(request) {
      const decision = decide(request);
      report(decision, options.getContext ? options.getContext() : undefined);
      return {
        response: acpPermissionResponse(request, decision),
        ...(decision.question ? { question: decision.question } : {}),
      };
    },
  };
}

module.exports = { GATE_STATE_DIR, gatePolicy, createAcpPermissionGate };
