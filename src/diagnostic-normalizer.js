"use strict";

const crypto = require("node:crypto");
const { createDiagnostic } = require("./code-context-contracts.js");

function stripAnsi(value) { return String(value || "").replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, ""); }
function diagnosticKey(value) { return crypto.createHash("sha256").update(JSON.stringify({ provider: value.provider, code: value.code || null, path: value.path, range: value.range, message: value.message })).digest("hex").slice(0, 24); }
function normalizeDiagnostic(input = {}, options = {}) {
  const provider = input.provider || input.source || options.provider || "diagnostics";
  const range = input.range?.startLine ? input.range : input.range?.start ? { startLine: Number(input.range.start.line || 0) + (options.zeroBased === false ? 0 : 1), startColumn: Number(input.range.start.character ?? input.range.start.column ?? 0) + (options.zeroBased === false ? 0 : 1), endLine: Number(input.range.end?.line ?? input.range.start.line ?? 0) + (options.zeroBased === false ? 0 : 1), endColumn: Number(input.range.end?.character ?? input.range.end?.column ?? 0) + (options.zeroBased === false ? 0 : 1) } : { startLine: Number(input.line || input.start?.line || 1), startColumn: Number(input.column || input.col || input.start?.col || 1), endLine: Number(input.endLine || input.end?.line || input.line || input.start?.line || 1), endColumn: Number(input.endColumn || input.end?.col || input.column || input.col || input.start?.col || 1) + 1 };
  const diagnostic = createDiagnostic({ provider, revision: input.revision || options.revision, configuration: input.configuration || options.configuration, path: input.path || input.file, range, severity: String(input.severity || "info").toLowerCase(), code: input.code || input.checkId || input.check_id, message: stripAnsi(input.message || input.text).replace(/\s+/g, " ").trim(), freshness: input.freshness || options.freshness || "fresh", degradation: input.degradation || options.degradation, gatingSafe: input.gatingSafe ?? options.gatingSafe ?? true, provenance: input.provenance || [{ provider, operation: options.operation || "diagnostics" }] });
  diagnostic.key = diagnosticKey(diagnostic);
  diagnostic.file = diagnostic.path;
  diagnostic.line = diagnostic.range.startLine;
  diagnostic.column = diagnostic.range.startColumn;
  diagnostic.endLine = diagnostic.range.endLine;
  diagnostic.endColumn = diagnostic.range.endColumn;
  return diagnostic;
}
function normalizeDiagnostics(rows, options = {}) {
  const previous = new Set((options.previous || []).map((row) => row.key || diagnosticKey(row)));
  const seen = new Set();
  const diagnostics = [];
  const errors = [];
  for (const row of rows || []) {
    try {
      const normalized = normalizeDiagnostic(row, options);
      if (seen.has(normalized.key)) continue;
      seen.add(normalized.key);
      if (options.sinceRevision && previous.has(normalized.key)) continue;
      diagnostics.push(normalized);
    } catch (error) { errors.push(String(error?.message || error)); }
  }
  diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.range.startLine - b.range.startLine || a.range.startColumn - b.range.startColumn || String(a.code || "").localeCompare(String(b.code || "")) || a.message.localeCompare(b.message));
  return { diagnostics, errors, deduplicated: Math.max(0, (rows || []).length - diagnostics.length - errors.length), sinceRevision: options.sinceRevision || null };
}

module.exports = { stripAnsi, diagnosticKey, normalizeDiagnostic, normalizeDiagnostics };
