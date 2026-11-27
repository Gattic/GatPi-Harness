"use strict";

/**
 * Pi's execution side of the Antigravity ACP file callbacks.
 *
 * When Pi advertises `fs.readTextFile`/`fs.writeTextFile`, the ACP server stops
 * using its own create/edit built-ins and adds `client_view_file`,
 * `client_create_file` and `client_edit_file` instead: every read and write then
 * comes back to Pi as `fs/read_text_file` or `fs/write_text_file`. These
 * handlers serve those requests.
 *
 * Pi is the executor here, so the gate runs before the file is touched, not
 * after a permission request: a call the server's own harness policy
 * auto-approves never reaches `session/request_permission`, and would otherwise
 * bypass Pi's rules. A refused call throws with the policy reasons and the
 * approval key, which the server reports as the tool's failure.
 */

const fs = require("node:fs");
const path = require("node:path");

const { formatAcpPermissionDecision } = require("./acp-permission-policy");

/** The message a refused callback carries back through the server to the model. */
function refusalMessage(decision) {
  const keys = (decision.missingApprovals || []).map((item) => item.key);
  const hint = keys.length ? `\nApprove once with: /policy-approve ${keys[0]}` : "";
  return `${formatAcpPermissionDecision(decision)}${hint}`;
}

/** ACP paths are absolute; a relative one is resolved against the session cwd. */
function absolutePath(value, cwd) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("ACP file request carries no path");
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

/** `line` is 1-based; `limit` counts lines from it, as ACP defines them. */
function sliceLines(content, line, limit) {
  if (line === undefined && limit === undefined) return content;
  const lines = content.split("\n");
  const start = Math.max(0, (line ?? 1) - 1);
  const end = limit === undefined ? lines.length : start + limit;
  return lines.slice(start, end).join("\n");
}

/**
 * @param {object} options
 * @param {object} options.gate the ACP authority gate (`createAcpPermissionGate`)
 * @param {string} [options.cwd] session working directory, for relative paths
 */
function createAcpClientFileHandlers(options = {}) {
  const gate = options.gate;
  const cwd = options.cwd || gate?.cwd || process.cwd();

  function decide(toolName, input) {
    if (typeof gate?.enforce !== "function") {
      throw new Error("ACP file callbacks need Pi's policy gate");
    }
    const decision = gate.enforce(toolName, input);
    if (!decision.allow) throw new Error(refusalMessage(decision));
  }

  return {
    async readTextFile(request = {}) {
      const file = absolutePath(request.path, cwd);
      decide("read", { path: file });
      const content = fs.readFileSync(file, "utf8");
      return { content: sliceLines(content, request.line, request.limit) };
    },

    async writeTextFile(request = {}) {
      const file = absolutePath(request.path, cwd);
      decide("write", { path: file });
      if (typeof request.content !== "string") {
        throw new Error("ACP write request carries no content");
      }
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, request.content, "utf8");
    },
  };
}

module.exports = { createAcpClientFileHandlers };
