"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { inventoryState } = require("./state-inventory");

const CONTENT_EXTENSIONS = new Set([".json", ".jsonl", ".md"]);
const FORBIDDEN_PROMOTION_PATHS = [
  /(?:^|\/)trace(?:\/|$)/i,
  /(?:^|\/)entropy(?:\/|$)/i,
  /(?:^|\/)branches\/snapshots(?:\/|$)/i,
  /(?:^|\/)reasoning\/snapshots(?:\/|$)/i,
  /(?:^|\/)verification(?:\/|$)/i,
  /(?:^|\/)topologies(?:\/|$)/i,
  /(?:^|\/)runs?(?:\/|$)/i,
  /(?:^|\/)evidence(?:\/|$)/i,
];
const DURABLE_TAGS = new Set(["architecture", "decision", "constraint", "policy", "invariant", "procedure", "workflow"]);

function hash(value, n = 16) { return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, n); }
function normalize(value) { return String(value || "").trim().toLowerCase().replace(/\s+/g, " "); }
function tokenSet(value) { return new Set(normalize(value).split(/[^a-z0-9_.:-]+/).filter((x) => x.length > 1)); }
function isForbiddenPromotionPath(file) { const normalized = String(file || "").replace(/\\/g, "/"); return FORBIDDEN_PROMOTION_PATHS.some((re) => re.test(normalized)); }
function sourceRoots(cwd) {
  return [
    path.join(cwd, ".pi", "cognitive-automation"),
    path.join(cwd, ".pi", "verification-center"),
    path.join(cwd, ".pi", "ast-refactor"),
    path.join(cwd, ".pi", "goal-state"),
  ];
}
function rootLabel(cwd, root) {
  const rel = path.relative(cwd, root).replace(/\\/g, "/");
  if (rel && !rel.startsWith("..")) return rel;
  return `external:${hash(root, 12)}`;
}
function catalog(cwd, options = {}) {
  const configuredRoots = sourceRoots(cwd);
  const roots = configuredRoots.filter((root) => fs.existsSync(root));
  const inventory = inventoryState(roots, { includeFile: (file) => CONTENT_EXTENSIONS.has(path.extname(file).toLowerCase()) });
  const byRoot = {};
  for (const root of configuredRoots) byRoot[rootLabel(cwd, root)] = { exists: fs.existsSync(root), files: 0, bytes: 0 };
  for (const file of inventory.files) {
    const label = rootLabel(cwd, file.root);
    byRoot[label] ||= { exists: true, files: 0, bytes: 0 };
    byRoot[label].files++;
    byRoot[label].bytes += file.bytes;
  }
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    sources: byRoot,
    files: inventory.summary.discoveredFiles,
    bytes: inventory.summary.discoveredBytes,
    metadata: { ...inventory.summary, skippedEntryReasons: inventory.summary.skippedReasons },
    inventory,
  };
}
function publicMap(cwd, options = {}) { const result = catalog(cwd, options); const { inventory, ...out } = result; return out; }

function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function cognitiveEntries(cwd) {
  const file = path.join(cwd, ".pi", "cognitive-automation", "cognitive-memory.json");
  const data = readJson(file, {});
  return (data?.entries || []).map((entry) => ({ ...entry, __file: file }));
}
function recordRef(entry) { return { recordId: String(entry.id || `memory_${hash(`${entry.type}:${entry.title}:${entry.content}`)}`), type: entry.type || "unknown", titleHash: hash(normalize(entry.title)), source: entry.provenance?.source || "unknown" }; }
function classifyEntry(entry, now = Date.now()) {
  const ref = recordRef(entry);
  const tags = new Set((entry.tags || []).map(normalize));
  const reasons = [];
  let action = "keep";
  const expiryMs = typeof entry.expiresAt === "number" ? entry.expiresAt : Date.parse(String(entry.expiresAt || ""));
  if (entry.verification === "contradicted" || (Number.isFinite(expiryMs) && expiryMs < now)) { action = "forget-review"; reasons.push(entry.verification === "contradicted" ? "typed contradiction" : "expired"); }
  const durableTag = [...tags].some((tag) => DURABLE_TAGS.has(tag));
  const forbiddenSource = ["verification-adapter", "anchoring-adapter", "pi-message", "pi-input"].includes(entry.provenance?.source);
  if (action === "keep" && ["semantic", "procedural", "strategic"].includes(entry.type) && ["verified", "corroborated"].includes(entry.verification) && durableTag && !forbiddenSource) {
    action = "promote-review"; reasons.push("typed verified durable candidate");
  }
  if (entry.provenance?.source === "verification-adapter") reasons.push("typed verifier evidence; excluded from durable promotion");
  if (entry.provenance?.source === "anchoring-adapter") reasons.push("typed file-change anchor; excluded from durable promotion");
  if (entry.type === "episodic") reasons.push("episodic working memory; excluded from durable promotion");
  return { ...ref, action, reasons, verification: entry.verification || "unverified", contentHash: hash(normalize(entry.content), 32), updatedAt: entry.updatedAt || null };
}
function classifyRecords(cwd, options = {}) {
  const entries = cognitiveEntries(cwd);
  const rows = entries.map((entry) => classifyEntry(entry, options.now || Date.now()));
  const duplicateGroups = new Map();
  for (const row of rows) {
    if (!row.contentHash) continue;
    const key = `${row.type}:${row.contentHash}`;
    const group = duplicateGroups.get(key) || [];
    group.push(row);
    duplicateGroups.set(key, group);
  }
  for (const group of duplicateGroups.values()) {
    if (group.length < 2) continue;
    for (const row of group.slice(1)) { if (row.action === "keep") row.action = "dedupe-review"; row.reasons.push("exact normalized duplicate"); }
  }
  return rows;
}
function curationPlan(cwd, options = {}) {
  const rows = classifyRecords(cwd, options);
  const counts = rows.reduce((out, row) => (out[row.action] = (out[row.action] || 0) + 1, out), {});
  return {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    counts,
    candidates: rows.filter((row) => row.action !== "keep").slice(0, Number(options.limit || 200)),
    exclusions: { forbiddenFileClasses: FORBIDDEN_PROMOTION_PATHS.map(String), fileLevelPromotion: false },
    totalRecords: rows.length,
    truncated: rows.filter((row) => row.action !== "keep").length > Number(options.limit || 200),
  };
}
function search(cwd, query, options = {}) {
  const q = normalize(query);
  if (!q) return { schemaVersion: 2, query: "", matches: [], coverage: { complete: true, reason: "empty-query" } };
  const terms = tokenSet(q);
  const rows = cognitiveEntries(cwd).map((entry) => {
    const text = normalize(`${entry.title || ""} ${entry.content || ""} ${(entry.tags || []).join(" ")}`);
    const tokens = tokenSet(text);
    let hits = 0; for (const term of terms) if (tokens.has(term)) hits++;
    const phrase = text.includes(q) ? 1 : 0;
    const allTerms = terms.size > 0 && hits === terms.size ? 1 : 0;
    const score = phrase * 3 + allTerms * 2 + (terms.size ? hits / terms.size : 0) + (["verified", "corroborated"].includes(entry.verification) ? 0.25 : 0);
    return { entry, score, hits, phrase: Boolean(phrase), allTerms: Boolean(allTerms) };
  }).filter((row) => row.hits > 0 || row.phrase).sort((a, b) => b.score - a.score || Number(b.entry.updatedAt || 0) - Number(a.entry.updatedAt || 0));
  return {
    schemaVersion: 2,
    query: q,
    matches: rows.slice(0, Number(options.limit || 50)).map((row) => ({ ...recordRef(row.entry), score: Number(row.score.toFixed(4)), phrase: row.phrase, allTerms: row.allTerms, verification: row.entry.verification || "unverified", contentPreview: String(row.entry.content || "").slice(0, 300) })),
    coverage: { complete: true, records: rows.length, source: "typed-cognitive-memory" },
  };
}
function lineage(cwd, id) {
  const entries = cognitiveEntries(cwd);
  const byId = new Map(entries.map((entry) => [String(entry.id), entry]));
  const seen = new Set();
  function walk(entryId) {
    if (seen.has(entryId)) return { id: entryId, cycle: true };
    const entry = byId.get(String(entryId));
    if (!entry) return { id: String(entryId), missing: true };
    seen.add(String(entryId));
    const links = Object.values(entry.links || {}).flat().map(String);
    return { ...recordRef(entry), verification: entry.verification || "unverified", supersedes: (entry.supersedes || []).map(String), contradicts: (entry.contradicts || []).map(String), links: links.map(walk) };
  }
  return id ? walk(String(id)) : { id: "", missing: true, reason: "id-required" };
}
function conflicts(cwd) {
  return cognitiveEntries(cwd).filter((entry) => entry.verification === "contradicted" || entry.metadata?.needsReview || (entry.contradicts || []).length).map((entry) => ({ ...recordRef(entry), verification: entry.verification, contradicts: (entry.contradicts || []).map(String), needsReview: Boolean(entry.metadata?.needsReview) })).slice(0, 100);
}
function prunePreview(cwd, options = {}) {
  const state = catalog(cwd, options);
  const candidates = state.inventory.files.filter((file) => isForbiddenPromotionPath(file.path) && file.bytes > Number(options.minBytes || 100_000)).map((file) => ({ fileClass: path.relative(cwd, file.path).replace(/\\/g, "/").split("/").slice(0, 4).join("/"), bytes: file.bytes, pathHash: hash(file.path), action: "subsystem-retention-review" })).slice(0, 100);
  return { preview: true, candidates, coverage: { ...state.metadata, complete: state.metadata.complete }, note: "No deletion is performed. Use the owning subsystem retention workflow after reviewing lineage." };
}

module.exports = { FORBIDDEN_PROMOTION_PATHS, isForbiddenPromotionPath, sourceRoots, catalog, publicMap, cognitiveEntries, classifyEntry, classifyRecords, curationPlan, search, lineage, conflicts, prunePreview, normalize };
