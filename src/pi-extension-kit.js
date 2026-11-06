"use strict";

// Shared helpers for .pi/extensions and extensions/ index.ts files.
// Extensions historically copy-pasted these; new/refactored extensions should
// import them from here so behavior stays uniform and fixable in one place.

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const {
  createExtensionTelemetry,
  readExtensionTelemetry,
  instrumentExtensionCommands,
  contextSessionKind,
  telemetrySessionToken,
} = require("./extension-telemetry");
const { operationKey, normalizeOperation, normalizeStringList } = require("./extension-args");
const { observeFixedOpportunity, opportunityReviewReport, reviewOpportunity } = require("./extension-opportunity-review");

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  return file;
}

function envEnabled(name, env = process.env) {
  return env[name] !== "0";
}

function includeGlobal(args) {
  return typeof args === "string" ? /--global|--include-global/.test(args) : Boolean(args?.includeGlobal || args?.global);
}

function short(text, n = 2000) {
  const value = String(text || "");
  return value.length > n ? `${value.slice(0, n)}…` : value;
}

const DEFAULT_CONTEXT_INJECTION_MAX_CHARS = 6000;

function contextLimit(value, fallback = DEFAULT_CONTEXT_INJECTION_MAX_CHARS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.max(32, Math.floor(parsed)) : fallback;
}

function boundedContext(text, maxChars = process.env.PI_CONTEXT_INJECTION_MAX_CHARS) {
  const value = String(text || "");
  const limit = contextLimit(maxChars);
  if (value.length <= limit) return value;
  const marker = `\n[context capped at ${limit} chars]`;
  if (marker.length >= limit) return value.slice(0, limit);
  return `${value.slice(0, limit - marker.length)}${marker}`;
}

function createContextInjector({ customType, maxChars, display = false, once = true } = {}) {
  if (!customType) throw new Error("context injector requires customType");
  let injected = false;
  const seen = new Set();
  return {
    reset() { injected = false; seen.clear(); },
    inject(content, options = {}) {
      if (once && injected) return null;
      const bounded = boundedContext(content, maxChars);
      if (!bounded.trim() || seen.has(bounded)) return null;
      seen.add(bounded);
      injected = true;
      const message = { customType, content: bounded, display: options.display ?? display };
      if (options.details !== undefined) message.details = options.details;
      return { message };
    },
  };
}

function execCapture(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs || 60_000,
    maxBuffer: options.maxBuffer || 10 * 1024 * 1024,
    env: options.env || process.env,
  });
  return {
    status: result.status ?? (result.error ? -1 : 0),
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function notify(ctx, message, level = "info") {
  // Headless (-p) runs drop ctx.ui.notify output entirely; command results
  // must fall back to stdout so scripted use can see them.
  if (!ctx?.hasUI || typeof ctx?.ui?.notify !== "function") {
    console.log(message);
    return;
  }
  try {
    ctx.ui.notify(message, level);
  } catch {
    console.log(message);
  }
}

function setTurnExitCode(ctx, code = 1) {
  // Headless (-p) runs exited 0 even when a command's work failed, so
  // scripted/CI use could not trust rc (flagged in three dogfooding rounds).
  // Pi print mode exits naturally, so process.exitCode set here survives.
  // Interactive sessions are untouched, and a recorded failure is never
  // downgraded back to success.
  if (ctx?.hasUI !== false) return false;
  const next = Number(code);
  if (!Number.isInteger(next) || next <= 0) return false;
  if (typeof process.exitCode === "number" && process.exitCode > 0) return true;
  process.exitCode = next;
  return true;
}

function toolResult(details) {
  return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
}

function registerOperationTool(pi, { name, label, description, parameters, defaultOperation, handlers }) {
  pi.registerTool({
    name,
    label,
    description,
    parameters,
    async execute(_id, params = {}, _signal, _update, ctx) {
      const handler = handlers[params.operation] || handlers[defaultOperation];
      const details = await handler(ctx, params);
      return toolResult(details);
    },
  });
}

module.exports = {
  TOOL_OUTPUT_SCHEMAS: require("./tool-result-contracts").TOOL_OUTPUT_SCHEMAS,
  governedCodemode: require("./codemode-policy").governedCodemode,
  observeFixedOpportunity,
  opportunityReviewReport,
  reviewOpportunity,
  readJson,
  writeJson,
  envEnabled,
  includeGlobal,
  short,
  DEFAULT_CONTEXT_INJECTION_MAX_CHARS,
  boundedContext,
  createContextInjector,
  normalizeOperation,
  normalizeStringList,
  execCapture,
  toolResult,
  registerOperationTool,
  createExtensionTelemetry,
  readExtensionTelemetry,
  instrumentExtensionCommands,
  contextSessionKind,
  telemetrySessionToken,
  notify,
  setTurnExitCode,
};
