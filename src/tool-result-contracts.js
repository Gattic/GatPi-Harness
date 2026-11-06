"use strict";

const { validateJsonSchema } = require("./role-result-schemas");
const { CANONICAL_OUTCOMES } = require("./outcome-schema");

const string = { type: "string" };
const number = { type: "number" };
const boolean = { type: "boolean" };
const object = { type: "object" };
const objects = { type: "array", items: object };
const strings = { type: "array", items: string };
const outcome = { enum: CANONICAL_OUTCOMES };
const degradation = { anyOf: [{ type: "null" }, { type: "object", required: ["code", "message"], properties: { code: string, message: string, retryable: boolean } }] };

const TOOL_OUTPUT_SCHEMAS = Object.freeze({
  code_context: {
    type: "object", required: ["provider", "queryId", "freshness", "gatingSafe", "truncated", "items"],
    properties: {
      schemaVersion: number, id: string, provider: string, queryId: string, strategyId: string,
      freshness: { enum: ["fresh", "stale", "unknown"] }, gatingSafe: boolean, truncated: boolean,
      degradation, outcome, metrics: object, diagnostics: object, errors: strings,
      items: { type: "array", items: { type: "object", required: ["id", "provider"], properties: { id: string, provider: string, path: string, symbolId: string, signature: string, snippet: string, contentRef: string, freshness: string, gatingSafe: boolean, degradation, provenance: objects } } },
      selectedTests: strings, mustRun: objects, highConfidence: objects,
    },
  },
  docs_lookup: {
    type: "object", required: ["generatedAt", "projectPath"],
    properties: {
      generatedAt: string, projectPath: string, query: string, terms: strings, source: string,
      results: { type: "array", items: { type: "object", required: ["path", "text", "startLine", "endLine"], properties: { path: string, text: string, source: string, score: number, startLine: number, endLine: number } } },
      summary: object, packageName: { anyOf: [string, { type: "null" }] }, found: boolean,
      package: object, docs: objects, readmePreview: string, guidance: string,
      path: string, offset: number, limit: number, totalLines: number, text: string,
      enabled: boolean, localDocs: number, nodeModuleDocs: number, truncation: object,
    },
  },
  test_runner: {
    type: "object", required: ["generatedAt"],
    properties: {
      generatedAt: string, projectPath: string, cwd: string, operation: string, profile: string,
      outcome, status: string, ok: { anyOf: [boolean, { type: "null" }] }, notApplicable: boolean,
      reason: string, selected: objects, profiles: object, changedFiles: strings,
      summary: object, runs: { type: "array", items: { type: "object", required: ["id", "ok"], properties: { id: string, ok: boolean, commandLine: string, durationMs: number, fullOutputPath: string, coverage: object } } },
      truncation: object,
    },
  },
});

function structuredToolResult(schema, result) {
  const data = result.details;
  const errors = validateJsonSchema(schema, data);
  if (errors.length) throw new TypeError(`Tool output violates its schema: ${errors.join("; ")}`);
  // UI and scripts share the canonical data, not a parse of the presentation.
  return { ...result, structuredContent: data };
}

module.exports = { TOOL_OUTPUT_SCHEMAS, structuredToolResult };
