"use strict";

const crypto = require("node:crypto");

const DEFAULT_MAX_CHARS = 20_000;
const MAX_FINDINGS = 64;

const SECRET_PATTERNS = Object.freeze([
  { code: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: "provider-token", pattern: /\b(?:(?:sk|pk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{16,})\b/ },
  { code: "credential-assignment", pattern: /\b(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\b\s*[:=]\s*['"]?[^\s'"`]{12,}/i },
  { code: "aws-access-key", pattern: /\bAKIA[A-Z0-9]{16}\b/ },
]);
const TRANSCRIPT_PATTERNS = Object.freeze([
  /<pi-session-transcript>/i,
  /"role"\s*:\s*"(?:assistant|user|toolResult)"[\s\S]{0,300}"content"\s*:/i,
  /"toolCallId"\s*:/i,
  /(?:^|\n)\s*(?:user|assistant|tool(?:Result)?)\s*:\s*.{40,}/i,
]);
const LOCAL_PATH_PATTERN = /(?:^|[\s`'"])(?:\/home\/[^\s`'"]+|\/Users\/[^\s`'"]+|[A-Za-z]:\\Users\\[^\s`'"]+)/m;
const PROMPT_INJECTION_PATTERNS = Object.freeze([
  /\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|prompts?|rules?)\b/i,
  /\b(?:system|developer)\s+(?:message|prompt)\s+(?:says|override|instruction)\b/i,
  /\b(?:reveal|print|return|expose)\s+(?:the\s+)?(?:system|developer|hidden)\s+(?:prompt|instructions?|reasoning)\b/i,
  /\bdo\s+not\s+follow\s+(?:the\s+)?(?:system|developer|prior)\s+(?:prompt|instructions?)\b/i,
]);
const EXFILTRATION_PATTERNS = Object.freeze([
  /\b(?:send|upload|post|transmit|exfiltrate)\b[^\n]{0,120}\b(?:secret|credential|token|password|private\s+key|environment)\b/i,
  /\b(?:secret|credential|token|password|private\s+key|environment)\b[^\n]{0,120}\b(?:webhook|remote\s+server|external\s+endpoint)\b/i,
]);
const DATA_URI_PATTERN = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{80,}/i;
const ENCODED_PAYLOAD_PATTERN = /(?:^|[^A-Za-z0-9+/])(?:[A-Za-z0-9+/]{160,}={0,2})(?:$|[^A-Za-z0-9+/])/m;
const CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const BIDI_PATTERN = /[\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

function sha256(value) { return crypto.createHash("sha256").update(String(value || "")).digest("hex"); }
function entropy(value) {
  const text = String(value || "");
  if (!text.length) return 0;
  const counts = new Map();
  for (const char of text) counts.set(char, (counts.get(char) || 0) + 1);
  let total = 0;
  for (const count of counts.values()) { const p = count / text.length; total -= p * Math.log2(p); }
  return total;
}
function highEntropyCredentialLike(text) {
  const matches = String(text || "").match(/[A-Za-z0-9_-]{32,160}/g) || [];
  return matches.some((token) => {
    if (/^[a-f0-9]{40,128}$/i.test(token)) return false;
    if (/^(?:REDACTED|placeholder|example|synthetic)/i.test(token)) return false;
    return /[A-Z]/.test(token) && /[a-z]/.test(token) && /\d/.test(token) && entropy(token) >= 4.25;
  });
}
function finding(code, category, severity, count = 1) { return { code, category, severity, count }; }
function increment(findings, row) {
  const prior = findings.find((candidate) => candidate.code === row.code);
  if (prior) prior.count += row.count;
  else if (findings.length < MAX_FINDINGS) findings.push(row);
}

function scanMemoryContent(value, options = {}) {
  const text = String(value || "").normalize("NFC");
  const maxChars = Number.isFinite(Number(options.maxChars)) ? Math.max(0, Number(options.maxChars)) : DEFAULT_MAX_CHARS;
  const findings = [];
  for (const item of SECRET_PATTERNS) if (item.pattern.test(text)) increment(findings, finding(item.code, "secret", "high"));
  if (TRANSCRIPT_PATTERNS.some((pattern) => pattern.test(text))) increment(findings, finding("transcript-payload", "privacy", "high"));
  if (LOCAL_PATH_PATTERN.test(text)) increment(findings, finding("absolute-local-path", "privacy", "high"));
  if (text.length > maxChars) increment(findings, finding("oversized", "bounds", "high", text.length - maxChars));
  if (CONTROL_PATTERN.test(text)) increment(findings, finding("invisible-control", "unicode", "high"));
  if (BIDI_PATTERN.test(text)) increment(findings, finding("bidirectional-control", "unicode", "high"));
  if (PROMPT_INJECTION_PATTERNS.some((pattern) => pattern.test(text))) increment(findings, finding("stored-prompt-injection", "prompt-injection", options.promptInjectionSeverity || "high"));
  if (EXFILTRATION_PATTERNS.some((pattern) => pattern.test(text))) increment(findings, finding("exfiltration-instruction", "exfiltration", "high"));
  if (DATA_URI_PATTERN.test(text)) increment(findings, finding("embedded-data-uri", "embedded-data", "high"));
  if (ENCODED_PAYLOAD_PATTERN.test(text)) increment(findings, finding("encoded-payload", "encoded-data", options.encodedPayloadSeverity || "medium"));
  if (highEntropyCredentialLike(text)) increment(findings, finding("high-entropy-credential", "secret", options.entropySeverity || "medium"));
  const blockingSeverities = new Set(options.blockingSeverities || ["high"]);
  const blocking = findings.filter((row) => blockingSeverities.has(row.severity));
  return {
    schemaVersion: 1,
    safe: blocking.length === 0,
    contentHash: `sha256:${sha256(text)}`,
    characters: text.length,
    findings,
    reasons: findings.map((row) => row.code),
    blockingReasons: blocking.map((row) => row.code),
  };
}

function assertMemoryContentSafe(value, options = {}) {
  const result = scanMemoryContent(value, options);
  if (result.safe) return result;
  const error = new Error(`durable memory content rejected: ${result.blockingReasons.join(",")}`);
  error.code = "MEMORY_CONTENT_UNSAFE";
  error.reasons = result.blockingReasons;
  error.scan = result;
  throw error;
}

function redactMemoryText(value, options = {}) {
  const maxChars = Math.max(0, Number(options.maxChars || 800));
  let text = String(value || "").normalize("NFC")
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/```[\s\S]*?```/g, "[REDACTED_CODE]")
    .replace(DATA_URI_PATTERN, "[REDACTED_DATA]")
    .replace(/[A-Za-z0-9+/]{160,}={0,2}/g, "[REDACTED_ENCODED_DATA]")
    .replace(/\b(?:(?:sk|pk)-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|glpat-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|ya29\.[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{16,})\b/g, "[REDACTED_TOKEN]")
    .replace(/\bAKIA[A-Z0-9]{16}\b/g, "[REDACTED_AWS_KEY]")
    .replace(/\b(?:api[_-]?key|secret|token|password|passwd|authorization|bearer)\b\s*[:=]\s*['"]?[^\s'"`]{8,}/gi, "[REDACTED_CREDENTIAL]")
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]")
    // Source excerpts are bounded before redaction, so a slice may end exactly
    // at a home-directory prefix. Redact that prefix too; otherwise JSON
    // escaping can turn the following newline into an apparent path suffix.
    .replace(/(?:\/home\/(?:[^\s`'"]+)?|\/Users\/(?:[^\s`'"]+)?|[A-Za-z]:\\Users\\(?:[^\s`'"]+)?)/g, "[REDACTED_PATH]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/(?:^|\n)\s*(?:\$|>|sudo\b|curl\b|wget\b|rm\s+-rf\b|npm\s+publish\b|git\s+push\b)[^\n]*/gi, "\n[REDACTED_COMMAND]");
  for (const pattern of PROMPT_INJECTION_PATTERNS) text = text.replace(new RegExp(pattern.source, `${pattern.flags.includes("i") ? "i" : ""}g`), "[REDACTED_INSTRUCTION]");
  for (const pattern of EXFILTRATION_PATTERNS) text = text.replace(new RegExp(pattern.source, `${pattern.flags.includes("i") ? "i" : ""}g`), "[REDACTED_EXFILTRATION]");
  text = text.replace(/[A-Za-z0-9_-]{32,160}/g, (token) => highEntropyCredentialLike(token) ? "[REDACTED_HIGH_ENTROPY]" : token).replace(/\s+/g, " ").trim();
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 14)).trimEnd()} [truncated]`;
  return text;
}

module.exports = {
  DEFAULT_MAX_CHARS,
  SECRET_PATTERNS,
  TRANSCRIPT_PATTERNS,
  LOCAL_PATH_PATTERN,
  PROMPT_INJECTION_PATTERNS,
  EXFILTRATION_PATTERNS,
  scanMemoryContent,
  assertMemoryContentSafe,
  redactMemoryText,
};
