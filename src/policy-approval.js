"use strict";

/**
 * Approval surfaces for policy decisions that need a person.
 *
 * Pi tool calls and Antigravity ACP tool calls both end up here, so the desktop
 * dialog and the paired-phone card stay one implementation: whichever surface
 * answers first wins, and an unanswered request blocks the operation.
 */

const { randomUUID } = require("node:crypto");

const APPROVAL_REQUEST_EVENT = "approval:request";
const APPROVAL_SETTLE_EVENT = "approval:settle";
/** One decision window for both surfaces: the first answer wins, and an unanswered request blocks the call. */
const APPROVAL_WINDOW_MS = 2 * 60 * 1000;

/**
 * Offer the decision to pi-dash's dashboard/phone; "unavailable" means no
 * answer surface is connected.
 */
function requestPhoneApproval(pi, decision, options = {}) {
  const windowMs = options.windowMs || APPROVAL_WINDOW_MS;
  const format = options.format || (() => String(decision?.reasons?.join("; ") || "approval required"));
  const id = `policy-${randomUUID()}`;
  let answer = () => {};
  const reply = new Promise((resolveReply) => {
    answer = resolveReply;
  });
  const payload = {
    request: {
      id,
      title: options.title || "Policy approval required",
      detail: format(decision),
      timeoutMs: windowMs,
    },
    respond: (value) => answer(value === "accept" ? "accept" : value === "deny" ? "deny" : "timeout"),
    handled: false,
  };
  pi.events.emit(APPROVAL_REQUEST_EVENT, payload);
  if (payload.handled !== true) answer("unavailable");
  return { id, handled: payload.handled === true, reply };
}

/**
 * Ask a person to approve one policy decision. The desktop dialog and the phone
 * card run in parallel; a phone answer withdraws its still-pending card.
 */
async function requestApproval(pi, ctx, decision, options = {}) {
  const windowMs = options.windowMs || APPROVAL_WINDOW_MS;
  const format = options.format || (() => String(decision?.reasons?.join("; ") || "approval required"));
  const title = options.title || "Policy approval required";
  const desktop = ctx.ui
    .confirm(title, `${format(decision)}\n\nAllow once for 24h?`, { timeout: windowMs })
    .then((ok) => (ok ? "accept" : "deny"));
  const phone = requestPhoneApproval(pi, decision, { ...options, windowMs, format, title });
  const first = await Promise.race([phone.reply, desktop]);
  if (phone.handled) pi.events.emit(APPROVAL_SETTLE_EVENT, { id: phone.id });
  if (first === "accept") return true;
  if (first === "deny") return false;
  // No phone answer surface, or its deadline passed: the desktop dialog is the remaining decision.
  return (await desktop) === "accept";
}

module.exports = {
  APPROVAL_REQUEST_EVENT,
  APPROVAL_SETTLE_EVENT,
  APPROVAL_WINDOW_MS,
  requestPhoneApproval,
  requestApproval,
};
