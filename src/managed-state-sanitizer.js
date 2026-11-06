"use strict";

/**
 * Shared privacy boundary for durable managed state.
 *
 * Callers receive a sanitized clone plus metadata-only rule counts. Original
 * values and surrounding text are never included in the report.
 */

const crypto = require("node:crypto");

const REDACTION_PREFIX = "[REDACTED:";
const REDACTION_RE = /^\[REDACTED:[a-z0-9-]+\]$/i;
const SENSITIVE_FIELD_NAMES = new Set([
  "accesstoken",
  "apikey",
  "authorization",
  "clientsecret",
  "credentials",
  "encryptedcontent",
  "githubtoken",
  "idtoken",
  "openaiapikey",
  "openaikey",
  "password",
  "passwd",
  "privatekey",
  "proxyauthorization",
  "reasoningsignature",
  "refreshtoken",
  "secret",
  "thinkingSignature".toLowerCase(),
  "token",
]);
const DEFAULT_DIAGNOSTIC_FIELDS = new Set([
  "after",
  "args",
  "arguments",
  "assumption",
  "before",
  "command",
  "content",
  "delta",
  "diff",
  "error",
  "input",
  "messages",
  "objective",
  "output",
  "partial",
  "payload",
  "patch",
  "plan",
  "prompt",
  "result",
  "statement",
  "stderr",
  "stdout",
  "systemprompt",
  "text",
  "transcript",
]);

function marker(rule) { return `${REDACTION_PREFIX}${rule}]`; }
function normalizedFieldName(name) { return String(name || "").replace(/[^a-z0-9]/gi, "").toLowerCase(); }
function isSensitiveField(name) { return SENSITIVE_FIELD_NAMES.has(normalizedFieldName(name)); }
function increment(counts, rule, amount = 1) { counts[rule] = (counts[rule] || 0) + amount; }
function isRedaction(value) { return typeof value === "string" && REDACTION_RE.test(value); }

function sanitizeText(text, counts) {
  let output = String(text);
  output = output.replace(/-----BEGIN ([A-Z ]*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, () => {
    increment(counts, "private-key");
    return marker("private-key");
  });
  output = output.replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, () => {
    increment(counts, "github-token");
    return marker("github-token");
  });
  output = output.replace(/sk-[A-Za-z0-9]{20,}/g, () => {
    increment(counts, "openai-key");
    return marker("openai-key");
  });
  output = output.replace(/\b(api[_-]?key|secret|token|password)\b(\s*[:=]\s*['\"]?)[A-Za-z0-9_\-]{16,}/gi, (_match, label, separator) => {
    increment(counts, "credential-assignment");
    return `${label}${separator}${marker("credential")}`;
  });
  return output;
}

function sanitizeManagedState(value) {
  const counts = {};
  const seen = new WeakMap();

  function visit(current, fieldName) {
    const sensitiveValue = typeof current === "string" || Buffer.isBuffer(current) || current != null && typeof current === "object";
    if (isSensitiveField(fieldName) && sensitiveValue && !isRedaction(current)) {
      increment(counts, "sensitive-field");
      return marker("sensitive-field");
    }
    if (typeof current === "string") return isRedaction(current) ? current : sanitizeText(current, counts);
    if (current == null || typeof current !== "object") return current;
    if (Buffer.isBuffer(current)) return Buffer.from(current);
    if (current instanceof Date) return new Date(current.getTime());
    if (seen.has(current)) return seen.get(current);
    if (Array.isArray(current)) {
      const result = [];
      seen.set(current, result);
      for (let index = 0; index < current.length; index++) result.push(visit(current[index], String(index)));
      return result;
    }
    const result = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) result[key] = visit(item, key);
    return result;
  }

  const sanitized = visit(value, "");
  const redactions = Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
  return { value: sanitized, changed: Object.values(redactions).some((count) => count > 0), redactions };
}

function sanitizeManagedStateValue(value) { return sanitizeManagedState(value).value; }

function stableDiagnosticJson(value) {
  try { return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? String(item) : item) ?? "null"; }
  catch { return JSON.stringify({ type: value == null ? "null" : typeof value }); }
}

function summarizeDiagnosticValue(value) {
  const serialized = typeof value === "string" ? value : stableDiagnosticJson(value);
  const summary = {
    schemaVersion: 1,
    type: value === null ? "null" : Array.isArray(value) ? "array" : Buffer.isBuffer(value) ? "buffer" : typeof value,
    sha256: crypto.createHash("sha256").update(serialized).digest("hex"),
    bytes: Buffer.byteLength(serialized),
  };
  if (typeof value === "string") {
    summary.chars = value.length;
    summary.lines = value.split(/\r?\n/).length;
  } else if (Array.isArray(value)) summary.items = value.length;
  else if (value && typeof value === "object") summary.keys = Object.keys(value).length;
  return summary;
}

function sanitizeManagedDiagnosticState(value, options = {}) {
  const base = sanitizeManagedState(value);
  const counts = { ...base.redactions };
  const fields = new Set([...(options.fields || DEFAULT_DIAGNOSTIC_FIELDS)].map(normalizedFieldName));
  const seen = new WeakMap();

  function visit(current) {
    if (current == null || typeof current !== "object") return current;
    if (Buffer.isBuffer(current)) return Buffer.from(current);
    if (current instanceof Date) return new Date(current.getTime());
    if (seen.has(current)) return seen.get(current);
    if (Array.isArray(current)) {
      const result = [];
      seen.set(current, result);
      for (const item of current) result.push(visit(item));
      return result;
    }
    const result = {};
    seen.set(current, result);
    for (const [key, item] of Object.entries(current)) {
      const diagnosticValue = item != null && (typeof item === "string" || Buffer.isBuffer(item) || typeof item === "object");
      if (fields.has(normalizedFieldName(key)) && diagnosticValue) {
        result[`${key}Summary`] = summarizeDiagnosticValue(item);
        increment(counts, "diagnostic-payload");
      } else result[key] = visit(item);
    }
    return result;
  }

  const sanitized = visit(base.value);
  const redactions = Object.fromEntries(Object.entries(counts).filter(([, count]) => count > 0).sort(([left], [right]) => left.localeCompare(right)));
  return { value: sanitized, changed: base.changed || Boolean(redactions["diagnostic-payload"]), redactions };
}

function diagnosticTextMetadata(text, label = "Diagnostic text") {
  const summary = summarizeDiagnosticValue(String(text || ""));
  const safeLabel = String(label || "Diagnostic text").replace(/[^A-Za-z0-9 _-]+/g, "").slice(0, 60) || "Diagnostic text";
  return `${safeLabel} metadata; sha256=${summary.sha256}; chars=${summary.chars}; lines=${summary.lines}; bytes=${summary.bytes}`;
}

function isDiagnosticTextMetadata(text) {
  return /^[A-Za-z0-9 _-]+ metadata; sha256=[a-f0-9]{64}; chars=\d+; lines=\d+; bytes=\d+$/.test(String(text || ""));
}

module.exports = {
  DEFAULT_DIAGNOSTIC_FIELDS,
  REDACTION_PREFIX,
  diagnosticTextMetadata,
  isDiagnosticTextMetadata,
  isSensitiveField,
  sanitizeManagedDiagnosticState,
  sanitizeManagedState,
  sanitizeManagedStateValue,
  summarizeDiagnosticValue,
};
