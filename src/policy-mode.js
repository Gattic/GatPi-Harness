"use strict";

/**
 * Policy enforcement mode, shared by every authority surface in this process.
 *
 * Pi tool calls are gated by the policy-enforcer extension, and Antigravity ACP
 * tool calls are gated by src/acp-permission-gate.js. Both must answer to one
 * mode: a user who runs `/policy-mode approval` expects the next ACP tool call
 * to ask too. The mode therefore lives here instead of in either caller.
 */

const MODES = Object.freeze(["advisory", "warn", "block", "approval"]);

function initialMode(env = process.env) {
  const configured = String(env.PI_POLICY_ENFORCER_MODE || "").trim();
  return MODES.includes(configured) ? configured : "block";
}

let current = initialMode();

function policyMode() {
  return current;
}

function setPolicyMode(next) {
  if (!MODES.includes(next)) {
    throw new Error(`unknown policy mode: ${String(next)} (expected ${MODES.join("|")})`);
  }
  current = next;
  return current;
}

module.exports = { MODES, policyMode, setPolicyMode };
