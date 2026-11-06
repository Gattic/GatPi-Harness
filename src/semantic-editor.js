"use strict";

/**
 * Deterministic semantic edit engine.
 *
 * This module intentionally avoids line-number patching and blind search/replace.
 * Edits are addressed by validated semantic anchors that combine whole-file content
 * hashes, semantic region identities, lightweight AST node identities where available,
 * token windows, structural neighbourhoods, dependency signatures and deterministic
 * similarity fallback. Applying a patch is transactional and reversible.
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { fileURLToPath } = require("node:url");

const DEFAULT_THRESHOLDS = Object.freeze({
  exactAnchor: 1,
  token: 0.82,
  structural: 0.72,
  semantic: 0.66,
  dependency: 0.5,
  applyConfidence: 0.78,
});

function sha256(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function shortHash(value) { return sha256(value).slice(0, 16); }
function normalizeText(text) { return String(text || "").replace(/\r\n/g, "\n"); }
function normalizeSemantic(text) { return normalizeText(text).toLowerCase().replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/[^a-z0-9_$]+/g, " ").trim(); }
function tokenArray(text) { return normalizeSemantic(text).split(/\s+/).filter(Boolean); }
function uniqueSorted(values) { return Array.from(new Set(values.filter(Boolean))).sort(); }
function jaccard(a, b) {
  const A = new Set(a); const B = new Set(b);
  if (!A.size && !B.size) return 1;
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit++;
  return hit / (A.size + B.size - hit);
}
function cosineTokens(a, b) {
  const A = new Map(); const B = new Map();
  for (const t of a) A.set(t, (A.get(t) || 0) + 1);
  for (const t of b) B.set(t, (B.get(t) || 0) + 1);
  let dot = 0; let na = 0; let nb = 0;
  for (const v of A.values()) na += v * v;
  for (const v of B.values()) nb += v * v;
  for (const [k, v] of A) dot += v * (B.get(k) || 0);
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function lineColFromOffset(text, offset) {
  const prefix = text.slice(0, offset);
  const lines = prefix.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

function findMatchingBrace(text, open) {
  let depth = 0; let quote = null; let escaped = false; let lineComment = false; let blockComment = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i]; const n = text[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && n === "/") { blockComment = false; i++; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === "\\") { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === "/" && n === "/") { lineComment = true; i++; continue; }
    if (c === "/" && n === "*") { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (c === "{") depth++;
    if (c === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function extractDependencies(text) {
  const deps = [];
  const patterns = [
    /require\(["']([^"']+)["']\)/g,
    /from\s+["']([^"']+)["']/g,
    /import\s*\(["']([^"']+)["']\)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text))) deps.push(m[1]);
  }
  return uniqueSorted(deps);
}

function inferLanguage(filePath, content) {
  const ext = path.extname(filePath || "").toLowerCase();
  if ([".js", ".cjs", ".mjs", ".ts", ".tsx", ".jsx"].includes(ext)) return "javascript";
  if (ext === ".json") return "json";
  if (/\b(function|const|let|class|module\.exports|require\()\b/.test(content)) return "javascript";
  return "text";
}

function parseStructuralNodes(content, filePath = "unknown") {
  const text = normalizeText(content);
  const language = inferLanguage(filePath, text);
  const nodes = [];
  if (language === "javascript") {
    const regexes = [
      { type: "class", re: /(?:^|\n)\s*class\s+([A-Za-z_$][\w$]*)[^\{]*\{/g, name: 1 },
      { type: "function", re: /(?:^|\n)\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, name: 1 },
      { type: "method", re: /(?:^|\n)\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, name: 1 },
      { type: "binding", re: /(?:^|\n)\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{/g, name: 1 },
    ];
    for (const spec of regexes) {
      let m;
      while ((m = spec.re.exec(text))) {
        const open = text.indexOf("{", m.index);
        const end = findMatchingBrace(text, open);
        if (open < 0 || end < 0) continue;
        const start = m.index + (text[m.index] === "\n" ? 1 : 0);
        const source = text.slice(start, end);
        const semanticId = `${spec.type}:${m[spec.name]}`;
        nodes.push(makeNode({ type: spec.type, name: m[spec.name], semanticId, start, end, source, text }));
      }
    }
  }

  if (!nodes.length) {
    let start = 0; let idx = 0;
    const parts = text.split(/\n{2,}/g);
    for (const part of parts) {
      const pos = text.indexOf(part, start);
      if (part.trim()) nodes.push(makeNode({ type: "region", name: `paragraph-${idx++}`, semanticId: `region:${shortHash(normalizeSemantic(part))}`, start: pos, end: pos + part.length, source: part, text }));
      start = pos + part.length;
    }
  }

  nodes.sort((a, b) => a.start - b.start || b.end - a.end);
  return nodes.map((node, i) => ({ ...node, previous: nodes[i - 1]?.identity || null, next: nodes[i + 1]?.identity || null }));
}

function makeNode({ type, name, semanticId, start, end, source, text }) {
  const before = text.slice(Math.max(0, start - 240), start);
  const after = text.slice(end, Math.min(text.length, end + 240));
  const tokens = tokenArray(source);
  const identity = `${semanticId}:${shortHash(normalizeSemantic(source).slice(0, 300))}`;
  return {
    type, name, semanticId, identity, start, end, source,
    sourceHash: sha256(source),
    normalizedHash: sha256(normalizeSemantic(source)),
    tokens,
    tokenHash: sha256(tokens.join(" ")),
    dependencies: extractDependencies(source),
    neighborhood: {
      beforeHash: shortHash(normalizeSemantic(before)),
      afterHash: shortHash(normalizeSemantic(after)),
      beforeTokens: tokenArray(before).slice(-32),
      afterTokens: tokenArray(after).slice(0, 32),
    },
    loc: { start: lineColFromOffset(text, start), end: lineColFromOffset(text, end) },
  };
}

class SemanticAnchor {
  constructor(input) { Object.assign(this, input); }

  static fromRegion({ filePath = "unknown", content, start, end, intent = "replace", dependencies = [] }) {
    const text = normalizeText(content);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) throw new Error("invalid region offsets for anchoring");
    const nodes = parseStructuralNodes(text, filePath);
    const exact = text.slice(start, end);
    const containing = nodes.filter((n) => n.start <= start && n.end >= end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    const before = text.slice(Math.max(0, start - 240), start);
    const after = text.slice(end, Math.min(text.length, end + 240));
    return new SemanticAnchor({
      version: 1,
      filePath,
      language: inferLanguage(filePath, text),
      intent,
      fileHash: sha256(text),
      regionHash: sha256(exact),
      normalizedRegionHash: sha256(normalizeSemantic(exact)),
      semanticRegionId: containing ? containing.semanticId : `region:${shortHash(normalizeSemantic(exact))}`,
      astNodeIdentity: containing ? containing.identity : null,
      structuralSignature: {
        containingType: containing?.type || "region",
        containingName: containing?.name || null,
        previous: containing?.previous || null,
        next: containing?.next || null,
        beforeHash: shortHash(normalizeSemantic(before)),
        afterHash: shortHash(normalizeSemantic(after)),
        beforeTokens: tokenArray(before).slice(-40),
        afterTokens: tokenArray(after).slice(0, 40),
      },
      tokenSignature: tokenArray(exact),
      dependencySignature: uniqueSorted([...extractDependencies(exact), ...dependencies]),
      originalLength: exact.length,
      originalPreviewHash: shortHash(exact.slice(0, 160) + "\n" + exact.slice(-160)),
    });
  }

  resolve(content, options = {}) {
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    const text = normalizeText(content);
    const nodes = parseStructuralNodes(text, this.filePath);
    const candidates = [];

    for (const node of nodes) {
      const ast = this.astNodeIdentity && node.identity === this.astNodeIdentity ? 1 : 0;
      const semanticRegion = node.semanticId === this.semanticRegionId ? 1 : 0;
      const token = cosineTokens(this.tokenSignature, node.tokens);
      const structural = jaccard(this.structuralSignature.beforeTokens || [], node.neighborhood.beforeTokens || []) * 0.5
        + jaccard(this.structuralSignature.afterTokens || [], node.neighborhood.afterTokens || []) * 0.5;
      const dependency = this.dependencySignature.length ? jaccard(this.dependencySignature, node.dependencies) : 1;
      const exact = node.sourceHash === this.regionHash || node.normalizedHash === this.normalizedRegionHash ? 1 : 0;
      const score = Math.max(exact, 0.28 * ast + 0.22 * semanticRegion + 0.22 * token + 0.18 * structural + 0.10 * dependency);
      candidates.push({ start: node.start, end: node.end, source: node.source, node, strategies: { exact, ast, semanticRegion, token, structural, dependency }, confidence: score });
    }

    // Deterministic token-window fallback inside the whole file for partial regions.
    const tokens = tokenArray(text);
    const wanted = this.tokenSignature || [];
    if (wanted.length >= 3) {
      const window = Math.max(3, wanted.length);
      let best = { score: 0, index: -1 };
      for (let i = 0; i <= tokens.length - Math.min(window, tokens.length); i++) {
        const slice = tokens.slice(i, i + window);
        const score = cosineTokens(wanted, slice);
        if (score > best.score) best = { score, index: i };
      }
      if (best.score >= thresholds.token) {
        const needle = wanted.slice(0, Math.min(8, wanted.length)).join(".*?");
        const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\.\*\\\?/g, "[\\s\\S]*?"), "i");
        const m = re.exec(normalizeSemantic(text));
        if (m) candidates.push({ start: 0, end: text.length, source: text, node: null, strategies: { exact: 0, ast: 0, semanticRegion: 0, token: best.score, structural: 0, dependency: 0 }, confidence: best.score * 0.7 });
      }
    }

    candidates.sort((a, b) => b.confidence - a.confidence || a.start - b.start || a.end - b.end);
    const best = candidates[0];
    if (!best) return { accepted: false, reason: "anchor-not-found", confidence: 0, candidates: [] };
    const ambiguous = candidates.filter((c) => Math.abs(c.confidence - best.confidence) < 0.015 && c.start !== best.start).length > 0;
    const drifted = this.fileHash !== sha256(text);
    const safe = best.confidence >= thresholds.applyConfidence && !ambiguous;
    return { accepted: safe, reason: safe ? "resolved" : ambiguous ? "ambiguous-anchor" : "low-confidence-anchor", drifted, confidence: best.confidence, match: best, candidates: candidates.slice(0, 5) };
  }
}

class SemanticPatch {
  constructor({ id, filePath, anchor, replacement, expectedBeforeHash, metadata = {} }) {
    this.id = id || `patch_${shortHash(JSON.stringify(anchor) + replacement)}`;
    this.filePath = filePath || anchor.filePath;
    this.anchor = anchor instanceof SemanticAnchor ? anchor : new SemanticAnchor(anchor);
    this.replacement = normalizeText(replacement);
    this.expectedBeforeHash = expectedBeforeHash || anchor.fileHash;
    this.metadata = metadata;
  }
}

class SemanticEditEngine {
  constructor(options = {}) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) };
    this.metricsState = { attempted: 0, applied: 0, rejected: 0, rollbacks: 0, drift: 0, conflicts: 0, duplicates: 0, malformed: 0, confidenceSum: 0, corruptionCheckpoints: 0 };
    this.history = [];
  }

  createPatch({ filePath, content, start, end, replacement, metadata }) {
    const anchor = SemanticAnchor.fromRegion({ filePath, content, start, end, intent: "replace" });
    return new SemanticPatch({ filePath, anchor, replacement, metadata });
  }

  validate(content, patches) {
    const text = normalizeText(content);
    const normalizedPatches = patches.map((p) => p instanceof SemanticPatch ? p : new SemanticPatch(p));
    const resolved = normalizedPatches.map((patch) => ({ patch, resolution: patch.anchor.resolve(text, { thresholds: this.thresholds }) }));
    const rejections = [];
    for (const item of resolved) {
      this.metricsState.attempted++;
      if (item.resolution.drifted) this.metricsState.drift++;
      if (!item.resolution.accepted) rejections.push({ patchId: item.patch.id, reason: item.resolution.reason, confidence: item.resolution.confidence });
      this.metricsState.confidenceSum += item.resolution.confidence || 0;
    }
    const accepted = resolved.filter((x) => x.resolution.accepted).sort((a, b) => a.resolution.match.start - b.resolution.match.start || a.resolution.match.end - b.resolution.match.end);
    for (let i = 1; i < accepted.length; i++) {
      const prev = accepted[i - 1]; const cur = accepted[i];
      if (cur.resolution.match.start < prev.resolution.match.end) {
        this.metricsState.conflicts++;
        rejections.push({ patchId: cur.patch.id, reason: "overlapping-edit", conflictsWith: prev.patch.id });
      }
    }
    const generatedHashes = new Set();
    for (const item of accepted) {
      const h = sha256(normalizeSemantic(item.patch.replacement));
      if (h && generatedHashes.has(h)) { this.metricsState.duplicates++; rejections.push({ patchId: item.patch.id, reason: "duplicate-generated-code" }); }
      generatedHashes.add(h);
      const malformed = detectMalformedRewrite(item.resolution.match.source, item.patch.replacement, item.patch.anchor.language);
      if (malformed) { this.metricsState.malformed++; rejections.push({ patchId: item.patch.id, reason: malformed }); }
    }
    const ok = rejections.length === 0;
    if (!ok) this.metricsState.rejected += normalizedPatches.length;
    return { ok, rejections, resolved };
  }

  apply(content, patches, options = {}) {
    const text = normalizeText(content);
    const validation = this.validate(text, patches);
    if (!validation.ok) return { ok: false, validation, content: text };
    const accepted = validation.resolved.filter((x) => x.resolution.accepted).sort((a, b) => b.resolution.match.start - a.resolution.match.start);
    const beforeHash = sha256(text);
    let next = text;
    const inverse = [];
    for (const item of accepted) {
      const { start, end, source } = item.resolution.match;
      next = next.slice(0, start) + item.patch.replacement + next.slice(end);
      inverse.push(new SemanticPatch({ filePath: item.patch.filePath, anchor: SemanticAnchor.fromRegion({ filePath: item.patch.filePath, content: next, start, end: start + item.patch.replacement.length }), replacement: source, metadata: { inverseOf: item.patch.id } }));
    }
    const afterHash = sha256(next);
    const checkpoint = { id: `txn_${shortHash(beforeHash + afterHash + Date.now())}`, beforeHash, afterHash, inverse: inverse.reverse(), patches: accepted.map((x) => x.patch.id), at: new Date().toISOString() };
    this.history.push(checkpoint);
    this.metricsState.applied += accepted.length;
    this.metricsState.corruptionCheckpoints++;

    const post = options.postValidate === false ? { ok: true } : validateBalancedSyntax(next, inferLanguage(options.filePath || accepted[0]?.patch.filePath || "", next));
    if (!post.ok) {
      this.metricsState.rollbacks++;
      return { ok: false, rolledBack: true, reason: "post-apply-corruption-check-failed", postValidation: post, content: text, checkpoint };
    }
    return { ok: true, content: next, checkpoint, validation };
  }

  transactFiles(fileMap, patchGroups) {
    const originals = new Map(Object.entries(fileMap).map(([k, v]) => [k, normalizeText(v)]));
    const outputs = new Map(originals);
    const checkpoints = [];
    for (const group of patchGroups) {
      const current = outputs.get(group.filePath);
      if (current == null) return { ok: false, reason: "missing-file", filePath: group.filePath, files: Object.fromEntries(originals) };
      const result = this.apply(current, group.patches, { filePath: group.filePath });
      if (!result.ok) return { ok: false, reason: result.reason || "patch-rejected", failed: result, files: Object.fromEntries(originals), rolledBack: true };
      outputs.set(group.filePath, result.content);
      checkpoints.push(result.checkpoint);
    }
    return { ok: true, files: Object.fromEntries(outputs), checkpoints };
  }

  rollback(content, checkpoint) {
    this.metricsState.rollbacks++;
    return this.apply(content, checkpoint.inverse, { postValidate: true });
  }

  optimisticApplyFile(filePath, patches, expectedFileHash = null) {
    const before = fs.readFileSync(filePath, "utf8");
    if (expectedFileHash && sha256(before) !== expectedFileHash) return { ok: false, reason: "race-condition-modification", expectedFileHash, actualFileHash: sha256(before) };
    const result = this.apply(before, patches, { filePath });
    if (!result.ok) return result;
    const now = fs.readFileSync(filePath, "utf8");
    if (sha256(now) !== sha256(before)) return { ok: false, reason: "race-condition-modification", expectedFileHash: sha256(before), actualFileHash: sha256(now) };
    fs.writeFileSync(filePath, result.content);
    return result;
  }

  metrics() {
    const avgConfidence = this.metricsState.attempted ? this.metricsState.confidenceSum / this.metricsState.attempted : 1;
    return { ...this.metricsState, averageConfidence: avgConfidence, rollbackRate: this.metricsState.applied ? this.metricsState.rollbacks / this.metricsState.applied : 0, rejectionRate: this.metricsState.attempted ? this.metricsState.rejected / this.metricsState.attempted : 0 };
  }
}

function detectMalformedRewrite(before, after, language) {
  if (!String(after).trim()) return null;
  const beforeKind = classifyRegion(before);
  const afterKind = classifyRegion(after);
  if (beforeKind !== "unknown" && afterKind !== "unknown" && beforeKind !== afterKind) return `malformed-partial-rewrite:${beforeKind}-to-${afterKind}`;
  const balanced = validateBalancedSyntax(after, language);
  if (!balanced.ok) return `malformed-partial-rewrite:${balanced.reason}`;
  return null;
}
function classifyRegion(src) {
  const s = String(src).trim();
  if (/^class\s+/.test(s)) return "class";
  if (/^(async\s+)?function\s+/.test(s)) return "function";
  if (/^(const|let|var)\s+/.test(s)) return "binding";
  if (/^[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{/.test(s)) return "method";
  return "unknown";
}
function validateBalancedSyntax(text, language = "text") {
  if (language === "json") { try { JSON.parse(text); return { ok: true }; } catch (err) { return { ok: false, reason: "invalid-json", error: err.message }; } }
  const stack = []; const pairs = { "(": ")", "[": "]", "{": "}" }; const close = new Set(Object.values(pairs));
  let quote = null; let escaped = false; let lineComment = false; let blockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]; const n = text[i + 1];
    if (lineComment) { if (c === "\n") lineComment = false; continue; }
    if (blockComment) { if (c === "*" && n === "/") { blockComment = false; i++; } continue; }
    if (quote) { if (escaped) { escaped = false; continue; } if (c === "\\") { escaped = true; continue; } if (c === quote) quote = null; continue; }
    if (c === "/" && n === "/") { lineComment = true; i++; continue; }
    if (c === "/" && n === "*") { blockComment = true; i++; continue; }
    if (c === '"' || c === "'" || c === "`") { quote = c; continue; }
    if (pairs[c]) stack.push(c);
    else if (close.has(c)) { const open = stack.pop(); if (pairs[open] !== c) return { ok: false, reason: "unbalanced-delimiters", offset: i }; }
  }
  if (quote || blockComment || stack.length) return { ok: false, reason: quote ? "unterminated-string" : blockComment ? "unterminated-comment" : "unclosed-delimiters" };
  return { ok: true };
}

function semanticDiff(before, after, filePath = "unknown") {
  const a = parseStructuralNodes(before, filePath);
  const b = parseStructuralNodes(after, filePath);
  const byIdA = new Map(a.map((n) => [n.semanticId, n]));
  const byIdB = new Map(b.map((n) => [n.semanticId, n]));
  const changes = [];
  for (const [id, node] of byIdA) {
    if (!byIdB.has(id)) changes.push({ type: "remove", semanticId: id, nodeType: node.type, name: node.name });
    else {
      const other = byIdB.get(id);
      if (node.normalizedHash !== other.normalizedHash) changes.push({ type: "modify", semanticId: id, nodeType: node.type, name: node.name, tokenSimilarity: cosineTokens(node.tokens, other.tokens), dependencyImpact: dependencyImpact(node.dependencies, other.dependencies) });
    }
  }
  for (const [id, node] of byIdB) if (!byIdA.has(id)) changes.push({ type: "add", semanticId: id, nodeType: node.type, name: node.name, dependencies: node.dependencies });
  return { beforeHash: sha256(normalizeText(before)), afterHash: sha256(normalizeText(after)), changes, structuralSimilarity: structuralSimilarity(a, b), dependencyImpact: dependencyImpact(extractDependencies(before), extractDependencies(after)) };
}
function structuralSimilarity(a, b) { return jaccard(a.map((n) => n.semanticId), b.map((n) => n.semanticId)); }
function dependencyImpact(a, b) { return { added: b.filter((x) => !a.includes(x)), removed: a.filter((x) => !b.includes(x)), unchanged: a.filter((x) => b.includes(x)) }; }

function lspPositionOffset(text, position = {}) {
  const lines = String(text).split("\n");
  const line = Math.max(0, Number(position.line || 0));
  const character = Math.max(0, Number(position.character || 0));
  let offset = 0;
  for (let i = 0; i < line; i++) offset += (lines[i] || "").length + 1;
  return Math.min(String(text).length, offset + character);
}
function workspaceEditRows(workspaceEdit = {}) {
  const rows = [];
  for (const [uri, edits] of Object.entries(workspaceEdit.changes || {})) rows.push({ uri, edits });
  for (const change of workspaceEdit.documentChanges || []) {
    if (change?.kind || !change?.textDocument?.uri || !Array.isArray(change.edits)) {
      const error = new Error(`Unsupported LSP workspace resource operation: ${change?.kind || "unknown"}`);
      error.code = "UNSUPPORTED_WORKSPACE_RESOURCE_OPERATION";
      throw error;
    }
    rows.push({ uri: change.textDocument.uri, version: change.textDocument.version, edits: change.edits });
  }
  return rows;
}
function workspaceUriPath(root, uri) {
  const absolute = String(uri).startsWith("file:") ? fileURLToPath(uri) : path.resolve(root, uri);
  const relative = path.relative(path.resolve(root), path.resolve(absolute));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    const error = new Error(`LSP workspace edit path escapes project root: ${uri}`);
    error.code = "WORKSPACE_EDIT_OUTSIDE_ROOT";
    throw error;
  }
  return { absolute: path.resolve(absolute), file: relative.replace(/\\/g, "/") };
}
function previewWorkspaceEdit(root, workspaceEdit, options = {}) {
  const changes = [];
  for (const row of workspaceEditRows(workspaceEdit)) {
    const target = workspaceUriPath(root, row.uri);
    const before = fs.readFileSync(target.absolute, "utf8");
    const expectedHash = options.expectedHashes?.[target.file] || options.expectedHashes?.[row.uri] || sha256(before);
    const edits = (row.edits || []).map((edit) => {
      if (!edit?.range || typeof edit.newText !== "string") throw new Error(`Malformed text edit for ${target.file}`);
      const start = lspPositionOffset(before, edit.range.start);
      const end = lspPositionOffset(before, edit.range.end);
      if (end < start) throw new Error(`Invalid edit range for ${target.file}`);
      return { start, end, newText: edit.newText, range: edit.range };
    }).sort((a, b) => a.start - b.start || a.end - b.end);
    for (let i = 1; i < edits.length; i++) if (edits[i].start < edits[i - 1].end) {
      const error = new Error(`Overlapping LSP edits for ${target.file}`);
      error.code = "OVERLAPPING_WORKSPACE_EDITS";
      throw error;
    }
    let after = before;
    for (const edit of edits.slice().sort((a, b) => b.start - a.start)) after = `${after.slice(0, edit.start)}${edit.newText}${after.slice(edit.end)}`;
    changes.push({ file: target.file, uri: row.uri, expectedHash, beforeHash: sha256(before), afterHash: sha256(after), edits, replacements: edits.length, before, after });
  }
  changes.sort((a, b) => a.file.localeCompare(b.file));
  return { schemaVersion: 1, projectPath: path.resolve(root), changes, summary: { files: changes.length, replacements: changes.reduce((sum, change) => sum + change.replacements, 0) } };
}
async function applyWorkspaceEdit(root, preview, options = {}) {
  if (!preview?.changes?.length) return { applied: true, changes: [], summary: { files: 0, replacements: 0 } };
  const queue = options.queue || ((_file, fn) => fn());
  const changes = preview.changes.slice().sort((a, b) => a.file.localeCompare(b.file));
  let index = 0;
  const run = async () => {
    if (index < changes.length) {
      const change = changes[index++];
      return queue(path.join(root, change.file), run);
    }
    for (const change of changes) {
      const absolute = path.join(root, change.file);
      const current = fs.readFileSync(absolute, "utf8");
      if (!change.expectedHash || sha256(current) !== change.expectedHash || sha256(current) !== change.beforeHash) {
        const error = new Error(`Stale LSP workspace edit for ${change.file}`);
        error.code = "STALE_WORKSPACE_EDIT";
        throw error;
      }
    }
    for (const change of changes) {
      const absolute = path.join(root, change.file);
      const mode = fs.statSync(absolute).mode;
      const tmp = `${absolute}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, change.after, { mode });
      fs.renameSync(tmp, absolute);
    }
    return { applied: true, changes: changes.map(({ before, after, ...change }) => change), summary: preview.summary };
  };
  return run();
}

module.exports = { SemanticAnchor, SemanticPatch, SemanticEditEngine, parseStructuralNodes, semanticDiff, validateBalancedSyntax, sha256, lspPositionOffset, previewWorkspaceEdit, applyWorkspaceEdit };
