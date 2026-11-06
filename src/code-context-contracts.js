"use strict";

const crypto = require("node:crypto");
const path = require("node:path");

const SCHEMA_VERSION = 1;
const SOURCE_KINDS = Object.freeze(["first_party", "generated", "vendored", "dependency", "build_output"]);
const FRESHNESS = Object.freeze(["fresh", "stale", "unknown"]);
const CARD_KINDS = Object.freeze(["definition", "reference", "implementation", "diagnostic", "target", "test", "text", "symbol", "file"]);
const RELATION_DIRECTIONS = Object.freeze(["incoming", "outgoing", "both"]);

function canonical(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (["id", "queryId", "elapsedMs", "generatedAt", "timestamp", "mtime", "mtimeMs"].includes(key)) continue;
    if (value[key] !== undefined) out[key] = canonical(value[key]);
  }
  return out;
}
function stableStringify(value) { return JSON.stringify(canonical(value)); }
function sha256(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function deterministicId(prefix, value) { return `${prefix}_${sha256(value).slice(0, 20)}`; }
function cleanText(value, max = 4000) { return value == null ? undefined : String(value).replace(/\r\n/g, "\n").slice(0, max); }
function normalizePath(value) {
  if (value == null || value === "") return undefined;
  const normalized = path.posix.normalize(String(value).replace(/\\/g, "/").replace(/^\.\//, ""));
  if (normalized === ".." || normalized.startsWith("../") || path.posix.isAbsolute(normalized)) throw new TypeError(`path must be repository-relative: ${value}`);
  return normalized;
}
function sourceKindForPath(value) {
  const file = String(value || "").replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(node_modules|vendor|vendors|third_party|third-party|externals?)(\/|$)/.test(file)) return "vendored";
  if (/(^|\/)(dist|build|out|coverage|\.next|target)(\/|$)/.test(file)) return "build_output";
  if (/(^|\/)(generated|gen)(\/|$)|(^|\/)[^/]+\.(generated|g)\.[^/]+$|\.pb\.(cc|h|go|py)$/.test(file)) return "generated";
  if (/(^|\/)(deps?|packages?\/[^/]+\/node_modules)(\/|$)/.test(file)) return "dependency";
  return "first_party";
}
function normalizeRange(value) {
  if (value == null) return undefined;
  const n = (key, fallback) => Number.isFinite(Number(value[key])) ? Math.max(1, Math.floor(Number(value[key]))) : fallback;
  const startLine = n("startLine", 1);
  const startColumn = n("startColumn", 1);
  const endLine = n("endLine", startLine);
  const endColumn = n("endColumn", startColumn);
  if (endLine < startLine || (endLine === startLine && endColumn < startColumn)) throw new TypeError("range end must not precede start");
  return { startLine, startColumn, endLine, endColumn };
}
function normalizeDegradation(value) {
  if (!value) return null;
  if (typeof value === "string") return { code: "degraded", message: cleanText(value, 1000), retryable: false };
  return {
    code: cleanText(value.code || "degraded", 120),
    message: cleanText(value.message || value.reason || "provider degraded", 1000),
    retryable: Boolean(value.retryable),
  };
}
function enumValue(value, allowed, fallback) { return allowed.includes(value) ? value : fallback; }
function normalizeProvenance(value, fallbackProvider) {
  const rows = Array.isArray(value) ? value : [];
  const out = rows.map((row) => ({ provider: cleanText(row?.provider || fallbackProvider, 80), operation: cleanText(row?.operation, 80) })).filter((row) => row.provider);
  return out.length ? out : fallbackProvider ? [{ provider: fallbackProvider, operation: undefined }] : [];
}
function baseRecord(input = {}, kindFallback) {
  const provider = cleanText(input.provider, 80);
  const file = normalizePath(input.path);
  const freshness = enumValue(input.freshness, FRESHNESS, "unknown");
  const degradation = normalizeDegradation(input.degradation);
  const sourceKind = enumValue(input.sourceKind, SOURCE_KINDS, sourceKindForPath(file));
  const record = {
    schemaVersion: SCHEMA_VERSION,
    id: input.id,
    provider,
    queryId: input.queryId,
    strategyId: cleanText(input.strategyId, 120),
    revision: input.revision,
    configuration: cleanText(input.configuration || "default", 160),
    sourceKind,
    path: file,
    range: normalizeRange(input.range),
    symbolId: cleanText(input.symbolId, 300),
    kind: cleanText(input.kind || kindFallback, 80),
    signature: cleanText(input.signature, 1200),
    snippet: cleanText(input.snippet, 4000),
    score: Number.isFinite(Number(input.score)) ? Math.max(0, Math.min(1, Number(input.score))) : undefined,
    scoreReasons: Array.from(new Set((input.scoreReasons || []).map((x) => cleanText(x, 200)).filter(Boolean))).sort(),
    queryTerms: Array.isArray(input.queryTerms) ? Array.from(new Set(input.queryTerms.map((x) => cleanText(x, 200)).filter(Boolean))).sort().slice(0, 32) : undefined,
    queryMatchCount: Number.isFinite(Number(input.queryMatchCount)) ? Math.max(0, Math.floor(Number(input.queryMatchCount))) : undefined,
    queryCoverage: Number.isFinite(Number(input.queryCoverage)) ? Math.max(0, Math.min(1, Number(input.queryCoverage))) : undefined,
    contentHash: cleanText(input.contentHash, 160),
    contentRef: cleanText(input.contentRef, 300),
    freshness,
    degradation,
    gatingSafe: Boolean(input.gatingSafe) && freshness === "fresh" && !degradation,
    provenance: normalizeProvenance(input.provenance, provider),
  };
  record.id ||= deterministicId("ctx", record);
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined));
}
function createCard(input = {}) {
  const card = baseRecord(input, "text");
  if (!card.provider) throw new TypeError("card.provider is required");
  if (!card.path && !card.symbolId) throw new TypeError("card.path or card.symbolId is required");
  if (!CARD_KINDS.includes(card.kind)) card.kind = "text";
  return card;
}
function createRelation(input = {}) {
  const record = baseRecord(input, "relation");
  record.fromId = cleanText(input.fromId || input.sourceId, 300);
  record.toId = cleanText(input.toId || input.targetId, 300);
  record.relationKind = cleanText(input.relationKind || input.relation, 120);
  record.direction = enumValue(input.direction, RELATION_DIRECTIONS, "outgoing");
  if (!record.provider || !record.fromId || !record.toId || !record.relationKind) throw new TypeError("relation provider/fromId/toId/relationKind are required");
  record.id = input.id || deterministicId("rel", record);
  return record;
}
function createDiagnostic(input = {}) {
  const record = baseRecord({ ...input, kind: "diagnostic" }, "diagnostic");
  record.severity = cleanText(input.severity || "info", 40).toLowerCase();
  record.code = cleanText(input.code, 120);
  record.message = cleanText(input.message, 2000);
  if (!record.provider || !record.path || !record.message) throw new TypeError("diagnostic provider/path/message are required");
  record.id = input.id || deterministicId("diag", record);
  return record;
}
function createTest(input = {}) {
  const record = baseRecord({ ...input, kind: "test" }, "test");
  record.testId = cleanText(input.testId || input.name, 300);
  record.status = cleanText(input.status || "unknown", 40);
  record.command = cleanText(input.command, 1000);
  record.durationMs = Number.isFinite(Number(input.durationMs)) ? Math.max(0, Number(input.durationMs)) : undefined;
  if (!record.provider || (!record.path && !record.testId)) throw new TypeError("test provider and path/testId are required");
  record.id = input.id || deterministicId("test", record);
  return record;
}
function createBuildFact(input = {}) {
  const record = baseRecord({ ...input, kind: input.kind || "target" }, "target");
  record.subject = cleanText(input.subject, 500);
  record.predicate = cleanText(input.predicate, 160);
  record.object = cleanText(input.object, 1000);
  if (!record.provider || !record.subject || !record.predicate || !record.object) throw new TypeError("build fact provider/subject/predicate/object are required");
  record.id = input.id || deterministicId("build", record);
  return record;
}
function createProviderStatus(input = {}) {
  const degradation = normalizeDegradation(input.degradation);
  const freshness = enumValue(input.freshness, FRESHNESS, "unknown");
  const status = {
    schemaVersion: SCHEMA_VERSION,
    provider: cleanText(input.provider, 80),
    backend: cleanText(input.backend, 120),
    available: input.available !== false,
    freshness,
    degradation,
    capabilities: Array.from(new Set((input.capabilities || []).map(String))).sort(),
    gatingSafe: Boolean(input.gatingSafe) && freshness === "fresh" && !degradation,
  };
  if (!status.provider) throw new TypeError("provider status provider is required");
  status.id = input.id || deterministicId("provider", status);
  return status;
}
function stableRecordCompare(a, b) {
  const score = Number(b?.score || 0) - Number(a?.score || 0);
  if (score) return score;
  return String(a?.path || "").localeCompare(String(b?.path || "")) || Number(a?.range?.startLine || 0) - Number(b?.range?.startLine || 0) || String(a?.kind || "").localeCompare(String(b?.kind || "")) || String(a?.id || "").localeCompare(String(b?.id || ""));
}
function validateRecord(value, type = "card") {
  const constructors = { card: createCard, relation: createRelation, diagnostic: createDiagnostic, test: createTest, buildFact: createBuildFact, providerStatus: createProviderStatus };
  try { return { ok: true, value: constructors[type](value) }; } catch (error) { return { ok: false, errors: [String(error?.message || error)] }; }
}
function createRetrievalEnvelope(input = {}) {
  const started = Number(input.elapsedMs);
  const rawItems = Array.isArray(input.items) ? input.items : [];
  const validItems = [];
  const errors = [];
  const itemType = input.itemType || "card";
  for (const raw of rawItems) {
    const checked = validateRecord(raw, itemType);
    if (checked.ok) validItems.push(checked.value); else errors.push(...checked.errors);
  }
  const malformed = !Array.isArray(input.items) || errors.length > 0;
  const degradation = normalizeDegradation(input.degradation || (malformed ? { code: "malformed_provider_output", message: errors.join("; ") || "provider items must be an array" } : null));
  const freshness = enumValue(input.freshness, FRESHNESS, validItems.length && validItems.every((item) => item.freshness === "fresh") ? "fresh" : "unknown");
  const items = input.preserveOrder === true ? validItems : validItems.sort(stableRecordCompare);
  const provider = cleanText(input.provider || items[0]?.provider || "unknown", 80);
  const queryId = input.queryId || deterministicId("query", { provider, strategyId: input.strategyId, revision: input.revision, configuration: input.configuration, query: input.query });
  const metrics = {
    elapsedMs: Number.isFinite(started) ? Math.max(0, started) : 0,
    candidatesRetrieved: Math.max(items.length, Number(input.metrics?.candidatesRetrieved || input.candidatesRetrieved || rawItems.length || 0)),
    candidatesReturned: items.length,
    bytesRetrieved: Math.max(0, Number(input.metrics?.bytesRetrieved || input.bytesRetrieved || 0)),
    bytesReturned: Math.max(0, Number(input.metrics?.bytesReturned || input.bytesReturned || Buffer.byteLength(JSON.stringify(items)))),
    tokensRetrieved: Math.max(0, Number(input.metrics?.tokensRetrieved || input.tokensRetrieved || 0)),
    tokensReturned: Math.max(0, Number(input.metrics?.tokensReturned || input.tokensReturned || 0)),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id || deterministicId("envelope", { provider, queryId, items, degradation }),
    provider,
    queryId,
    strategyId: cleanText(input.strategyId || "unspecified", 120),
    revision: input.revision,
    configuration: cleanText(input.configuration || "default", 160),
    freshness,
    degradation,
    gatingSafe: Boolean(input.gatingSafe) && freshness === "fresh" && !degradation && items.every((item) => item.gatingSafe),
    truncated: Boolean(input.truncated),
    metrics,
    errors,
    items,
  };
}
function validateEnvelope(value) {
  try {
    const normalized = createRetrievalEnvelope(value);
    return { ok: !normalized.degradation, value: normalized, errors: normalized.errors };
  } catch (error) { return { ok: false, value: createRetrievalEnvelope({ provider: value?.provider, items: null, degradation: String(error?.message || error) }), errors: [String(error?.message || error)] }; }
}
function compactRetrievalEnvelope(input, options = {}) {
  const envelope = createRetrievalEnvelope(input);
  const maxItems = Math.max(1, Number(options.maxItems || 20));
  const lines = [
    `retrieval ${envelope.queryId} via ${envelope.provider} (${envelope.freshness}${envelope.gatingSafe ? ", gating-safe" : ", advisory"})`,
    `candidates ${envelope.metrics.candidatesReturned}/${envelope.metrics.candidatesRetrieved}; ${envelope.metrics.tokensReturned} tokens; ${envelope.metrics.elapsedMs}ms${envelope.truncated ? "; truncated" : ""}`,
  ];
  if (envelope.degradation) lines.push(`degraded ${envelope.degradation.code}: ${envelope.degradation.message}`);
  const stages = input?.diagnostics;
  if (stages) lines.push(`stages query=${stages.queryGeneration?.status || "unknown"}(${stages.queryGeneration?.generatedQueries ?? 0}) candidate=${stages.candidateGeneration?.status || "unknown"}(${stages.candidateGeneration?.eligibleCandidates ?? 0}/${stages.candidateGeneration?.rawCandidates ?? 0}) ranking=${stages.ranking?.status || "unknown"}(${stages.ranking?.candidatesRanked ?? 0}) packing=${stages.packing?.status || "unknown"}(${stages.packing?.selectedCandidates ?? 0}, ${stages.packing?.serializedTokens ?? 0}/${stages.packing?.budgetTokens ?? 0} tokens)`);
  for (const item of envelope.items.slice(0, maxItems)) {
    const location = item.path ? `${item.path}${item.range ? `:${item.range.startLine}:${item.range.startColumn}` : ""}` : item.symbolId || item.id;
    const details = [item.kind, item.signature, item.message, item.contentRef ? `ref=${item.contentRef}` : null, item.score != null ? `score=${item.score.toFixed(3)}` : null, item.scoreReasons?.length ? `why=${item.scoreReasons.join(",")}` : null, item.freshness, item.degradation?.code].filter(Boolean).join(" | ");
    lines.push(`- ${item.id} ${location} — ${details}`);
  }
  if (envelope.items.length > maxItems) lines.push(`- … ${envelope.items.length - maxItems} more result(s)`);
  if (envelope.errors.length) lines.push(`errors: ${envelope.errors.join("; ")}`);
  return lines.join("\n");
}

module.exports = {
  SCHEMA_VERSION,
  SOURCE_KINDS,
  FRESHNESS,
  CARD_KINDS,
  canonical,
  stableStringify,
  sha256,
  deterministicId,
  normalizePath,
  sourceKindForPath,
  normalizeRange,
  normalizeDegradation,
  createCard,
  createRelation,
  createDiagnostic,
  createTest,
  createBuildFact,
  createProviderStatus,
  createRetrievalEnvelope,
  validateRecord,
  validateEnvelope,
  stableRecordCompare,
  compactRetrievalEnvelope,
};
