"use strict";

/**
 * Cognitive memory substrate for Pi-style coding harnesses.
 *
 * This is deliberately structured memory, not a vector database wrapper.  The
 * four memory systems have independent schemas, scoring functions, decay,
 * compaction and forgetting behavior while sharing a small lexical semantic
 * scorer for deterministic local operation.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { diagnosticTextMetadata, isDiagnosticTextMetadata, sanitizeManagedStateValue } = require("./managed-state-sanitizer");

const MEMORY_TYPES = Object.freeze({
  episodic: {
    type: "episodic",
    description: "Debugging attempts, failures, retries, experiments, prior sessions, execution history",
    halfLifeMs: 3 * 24 * 60 * 60 * 1000,
    compactAfterMs: 36 * 60 * 60 * 1000,
    forgetBelow: 0.16,
    speculativePenalty: 0.35,
    baseWeight: 0.82,
    architectureBias: 0.15,
    weights: { semantic: 0.24, symbolic: 0.18, recency: 0.30, confidence: 0.08, verification: 0.08, usage: 0.08, architecture: 0.04 },
  },
  semantic: {
    type: "semantic",
    description: "Architecture knowledge, APIs, invariants, project structure, dependencies, conventions",
    halfLifeMs: 120 * 24 * 60 * 60 * 1000,
    compactAfterMs: 30 * 24 * 60 * 60 * 1000,
    forgetBelow: 0.08,
    speculativePenalty: 0.22,
    baseWeight: 1.08,
    architectureBias: 0.85,
    weights: { semantic: 0.28, symbolic: 0.18, recency: 0.08, confidence: 0.14, verification: 0.16, usage: 0.06, architecture: 0.10 },
  },
  procedural: {
    type: "procedural",
    description: "Deployment workflows, tests, builds, migrations, operational playbooks",
    halfLifeMs: 45 * 24 * 60 * 60 * 1000,
    compactAfterMs: 14 * 24 * 60 * 60 * 1000,
    forgetBelow: 0.10,
    speculativePenalty: 0.25,
    baseWeight: 1.0,
    architectureBias: 0.35,
    weights: { semantic: 0.22, symbolic: 0.24, recency: 0.12, confidence: 0.12, verification: 0.12, usage: 0.13, architecture: 0.05 },
  },
  strategic: {
    type: "strategic",
    description: "Optimization priorities, philosophy, maintainability, performance, security, long-term goals",
    halfLifeMs: 240 * 24 * 60 * 60 * 1000,
    compactAfterMs: 90 * 24 * 60 * 60 * 1000,
    forgetBelow: 0.06,
    speculativePenalty: 0.18,
    baseWeight: 1.12,
    architectureBias: 0.70,
    weights: { semantic: 0.20, symbolic: 0.16, recency: 0.05, confidence: 0.17, verification: 0.17, usage: 0.08, architecture: 0.17 },
  },
});

const VERIFICATION_SCORE = Object.freeze({ verified: 1, corroborated: 0.86, inferred: 0.62, speculative: 0.38, contradicted: 0, stale: 0.18 });
// Per-type retention caps applied on every persistence. They sit above the
// observed steady-state volume so they bound future growth without deleting
// live history; verified entries are never removed to satisfy a cap.
const DEFAULT_MAX_BY_TYPE = Object.freeze({ episodic: 5000, procedural: 3000, semantic: 1000, strategic: 300 });
const ARCH_TAGS = new Set(["architecture", "api", "invariant", "contract", "dependency", "security", "performance", "maintainability", "convention"]);
const STOP = new Set("a an and are as at be by for from has have in is it of on or that the this to with must should via was were will".split(" "));

function now() { return Date.now(); }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function normalize(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9_./:-]+/g, " ").trim(); }
function dedupeKey(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function tokens(text) { return normalize(text).split(/\s+/).filter((t) => t && !STOP.has(t)); }
function tokenSet(text) { return new Set(tokens(text)); }
function semanticOverlap(a, b) {
  const A = tokenSet(a); const B = tokenSet(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / Math.sqrt(A.size * B.size);
}
function estimateTokens(text) { return Math.max(1, Math.ceil(String(text || "").length / 4)); }
function hash(raw) {
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function makeId(type, text, at) { return `mem_${type}_${hash(`${type}:${normalize(text).slice(0, 180)}:${at}`)}`; }
function contentFingerprint(entry) { return `${entry.type}:sha256:${crypto.createHash("sha256").update(normalize(entry.content)).digest("hex")}`; }
function firstSentence(text) { return String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)[0].slice(0, 260); }
function uniq(xs) { return Array.from(new Set((xs || []).filter(Boolean))); }
function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function ensureType(type) { if (!MEMORY_TYPES[type]) throw new Error(`Unknown memory type: ${type}`); }

class MemoryEntry {
  constructor(input, clock = now) {
    input = sanitizeManagedStateValue(input);
    if (input.title === "Assistant turn" && input.provenance?.source === "pi-message" && !isDiagnosticTextMetadata(input.content)) {
      input = { ...input, content: diagnosticTextMetadata(input.content, "Assistant response") };
    }
    ensureType(input.type);
    const at = input.createdAt || clock();
    this.id = input.id || makeId(input.type, `${input.title || ""}\n${input.content || ""}`, at);
    this.type = input.type;
    this.title = input.title || input.kind || input.type;
    this.content = String(input.content || "");
    this.kind = input.kind || "memory";
    this.tags = uniq(input.tags || []);
    this.symbols = uniq(input.symbols || []);
    this.paths = uniq(input.paths || []);
    this.createdAt = at;
    this.updatedAt = input.updatedAt || at;
    this.lastAccessedAt = input.lastAccessedAt || this.updatedAt;
    this.expiresAt = input.expiresAt || null;
    this.confidence = clamp01(input.confidence ?? 0.55);
    this.verification = input.verification || "inferred";
    this.provenance = { source: "unknown", ...(input.provenance || {}) };
    this.usageFrequency = input.usageFrequency || 0;
    this.architectureWeight = clamp01(input.architectureWeight ?? inferArchitectureWeight(input));
    this.links = normalizeLinks(input.links);
    this.supersedes = uniq(input.supersedes || []);
    this.contradicts = uniq(input.contradicts || []);
    this.speculative = Boolean(input.speculative ?? this.verification === "speculative");
    this.metadata = { ...(input.metadata || {}) };
  }

  text() { return `${this.title}\n${this.content}\n${this.tags.join(" ")}\n${this.symbols.join(" ")}\n${this.paths.join(" ")}`; }
  touch(at = now()) { this.lastAccessedAt = at; this.usageFrequency += 1; }
  toJSON() { return { ...this, links: this.links }; }
}

function inferArchitectureWeight(input) {
  const t = new Set([...(input.tags || []), input.kind || ""]);
  let score = [...t].some((x) => ARCH_TAGS.has(x)) ? 0.75 : 0.25;
  if (input.type === "semantic") score += 0.18;
  if (input.type === "strategic") score += 0.12;
  if ((input.content || "").match(/\b(must|invariant|contract|api|architecture|security|performance)\b/i)) score += 0.15;
  return clamp01(score);
}

function normalizeLinks(links = {}) {
  return {
    episodic: uniq(links.episodic || []),
    semantic: uniq(links.semantic || []),
    procedural: uniq(links.procedural || []),
    strategic: uniq(links.strategic || []),
  };
}

class CognitiveMemory {
  constructor(options = {}) {
    this.clock = options.clock || now;
    this.entries = new Map();
    this.audit = [];
    this.lastConsolidatedAt = 0;
    this.options = { consolidationIntervalMs: 60 * 60 * 1000, maxByType: DEFAULT_MAX_BY_TYPE, ...options };
  }

  // Persistence enforces the retention invariant: no duplicates and no type
  // above its cap. The dedupe key ignores punctuation and case so legacy
  // near-duplicates collapse; caps sit above steady-state volume and bound
  // future growth instead of deleting live history.
  dedupeExact() {
    const keep = new Map(); const decisions = [];
    for (const entry of this.entries.values()) {
      const key = `${entry.type}\u0000${dedupeKey(entry.content)}`;
      const prior = keep.get(key);
      if (!prior) { keep.set(key, entry); continue; }
      const winner = rankTruth(entry) >= rankTruth(prior) ? entry : prior;
      const loser = winner === entry ? prior : entry;
      winner.confidence = clamp01(Math.max(winner.confidence, loser.confidence) + 0.02);
      winner.tags = uniq([...winner.tags, ...loser.tags]); winner.symbols = uniq([...winner.symbols, ...loser.symbols]); winner.paths = uniq([...winner.paths, ...loser.paths]);
      winner.links = mergeLinks(winner.links, loser.links); winner.supersedes = uniq([...winner.supersedes, loser.id, ...loser.supersedes]);
      this.entries.delete(loser.id); keep.set(key, winner);
      decisions.push({ action: "deduplicate-exact", kept: winner.id, removed: loser.id, type: winner.type });
    }
    return decisions;
  }

  boundByCount(maxByType = this.options.maxByType || DEFAULT_MAX_BY_TYPE) {
    const decisions = [];
    for (const [type, max] of Object.entries(maxByType)) {
      // A malformed or negative cap falls back to the documented default instead
      // of removing every non-verified entry of that type.
      const configured = Number(max);
      const cap = Number.isFinite(configured) && configured >= 0 ? Math.floor(configured) : DEFAULT_MAX_BY_TYPE[type];
      if (!Number.isFinite(cap)) continue;
      const list = [...this.entries.values()].filter((entry) => entry.type === type);
      if (list.length <= cap) continue;
      const excess = list.length - cap;
      // Verified entries are preserved even when they alone exceed the cap.
      const removable = list.filter((entry) => entry.verification !== "verified").sort((a, b) => rankTruth(a) - rankTruth(b) || a.updatedAt - b.updatedAt);
      for (const entry of removable.slice(0, excess)) {
        if (this.entries.delete(entry.id)) decisions.push({ action: "count-pruned", type, removed: entry.id, cap });
      }
    }
    return decisions;
  }

  remember(input) {
    const entry = input instanceof MemoryEntry ? input : new MemoryEntry(input, this.clock);
    const validation = this.validate(entry);
    if (!validation.accepted) {
      this.audit.push({ at: this.clock(), action: "reject", id: entry.id, type: entry.type, reasons: validation.reasons });
      return { accepted: false, entry, validation };
    }
    const normalizedContent = normalize(entry.content);
    const duplicate = [...this.entries.values()].find((other) => other.type === entry.type && normalize(other.content) === normalizedContent);
    if (duplicate) {
      duplicate.tags = uniq([...duplicate.tags, ...entry.tags]); duplicate.symbols = uniq([...duplicate.symbols, ...entry.symbols]); duplicate.paths = uniq([...duplicate.paths, ...entry.paths]); duplicate.confidence = Math.max(duplicate.confidence, entry.confidence); duplicate.updatedAt = Math.max(duplicate.updatedAt, entry.updatedAt);
      if ((VERIFICATION_SCORE[entry.verification] ?? 0) > (VERIFICATION_SCORE[duplicate.verification] ?? 0)) duplicate.verification = entry.verification;
      duplicate.provenance = duplicate.provenance?.source === "unknown" ? entry.provenance : duplicate.provenance;
      this.audit.push({ at: this.clock(), action: "deduplicate-on-insert", id: duplicate.id, rejectedId: entry.id, type: entry.type, fingerprint: contentFingerprint(entry) });
      return { accepted: true, entry: duplicate, validation: { ...validation, duplicates: uniq([...(validation.duplicates || []), duplicate.id]) }, deduped: true };
    }
    this.entries.set(entry.id, entry);
    this.audit.push({ at: this.clock(), action: "remember", id: entry.id, type: entry.type, provenance: entry.provenance });
    return { accepted: true, entry, validation, deduped: false };
  }

  validate(candidate) {
    const reasons = [];
    const duplicates = [];
    const contradictions = [];
    for (const other of this.entries.values()) {
      const sim = semanticOverlap(candidate.text(), other.text());
      if (candidate.type === other.type && sim > 0.94) duplicates.push(other.id);
      const explicitContradiction = candidate.contradicts.includes(other.id) || other.contradicts.includes(candidate.id);
      const textualContradiction = candidate.type === other.type && sim > 0.60 && polarity(candidate.content) * polarity(other.content) < 0;
      if (explicitContradiction || textualContradiction) contradictions.push(other.id);
    }
    if (candidate.verification === "contradicted") reasons.push("contradicted memory cannot be inserted");
    const verifiedConflict = contradictions.map((id) => this.entries.get(id)).find((e) => e && e.verification === "verified" && candidate.verification !== "verified");
    if (verifiedConflict) reasons.push(`unverified memory contradicts verified entry ${verifiedConflict.id}`);
    return { accepted: reasons.length === 0, reasons, duplicates, contradictions };
  }

  link(fromId, toId, relation = "references") {
    const from = this.entries.get(fromId); const to = this.entries.get(toId);
    if (!from || !to) return false;
    from.links[to.type] = uniq([...(from.links[to.type] || []), to.id]);
    this.audit.push({ at: this.clock(), action: "link", from: fromId, to: toId, relation });
    return true;
  }

  retrieve(query = "", options = {}) {
    const at = this.clock();
    const types = options.types || Object.keys(MEMORY_TYPES);
    const limit = options.limit || 12;
    const filters = options.filters || {};
    const excludeProvenanceSources = new Set(options.excludeProvenanceSources || []);
    const architectureFocus = clamp01(options.architectureFocus ?? (query.match(/architecture|api|invariant|dependency|security|performance/i) ? 0.8 : 0.35));
    const dependencyFocus = uniq(options.dependencyFocus || []);
    const scored = [];

    for (const entry of this.entries.values()) {
      if (!types.includes(entry.type) || excludeProvenanceSources.has(entry.provenance?.source)) continue;
      const symbolic = symbolicMatch(entry, filters, dependencyFocus);
      if (!symbolic.pass) continue;
      const score = this.score(entry, { query, at, filters, dependencyFocus, architectureFocus, symbolicScore: symbolic.score });
      if (score.total <= 0) continue;
      scored.push({ entry, score, why: explainScore(entry, score, symbolic.reasons) });
    }

    scored.sort((a, b) => b.score.total - a.score.total || b.entry.updatedAt - a.entry.updatedAt);
    const selected = scored.slice(0, limit);
    for (const x of selected) x.entry.touch(at);
    const lineage = selected.map((x) => this.lineage(x.entry.id));
    const result = { entries: selected.map((x) => x.entry), observations: { query, included: selected.map((x) => ({ id: x.entry.id, type: x.entry.type, title: x.entry.title, score: x.score, why: x.why })), candidates: scored.length, lineage } };
    this.audit.push({ at, action: "retrieve", query, selected: selected.map((x) => x.entry.id), candidates: scored.length });
    return result;
  }

  score(entry, ctx) {
    const cfg = MEMORY_TYPES[entry.type];
    const age = Math.max(0, ctx.at - entry.updatedAt);
    const accessAge = Math.max(0, ctx.at - entry.lastAccessedAt);
    const recency = entry.expiresAt && entry.expiresAt < ctx.at ? 0 : Math.exp(-age / cfg.halfLifeMs);
    const accessRecency = Math.exp(-accessAge / cfg.halfLifeMs);
    const semantic = ctx.query ? semanticOverlap(ctx.query, entry.text()) : 0.42;
    const symbolic = ctx.symbolicScore;
    const confidence = entry.confidence;
    const verification = VERIFICATION_SCORE[entry.verification] ?? 0.5;
    const usage = clamp01(Math.log1p(entry.usageFrequency) / Math.log(30));
    const architecture = clamp01(entry.architectureWeight * (0.5 + ctx.architectureFocus));
    const speculativePenalty = entry.speculative ? cfg.speculativePenalty : 1;
    const stalePenalty = entry.expiresAt && entry.expiresAt < ctx.at ? 0.25 : 1;
    const total = clamp01(cfg.baseWeight * speculativePenalty * stalePenalty * (
      cfg.weights.semantic * semantic + cfg.weights.symbolic * symbolic + cfg.weights.recency * ((recency + accessRecency) / 2) +
      cfg.weights.confidence * confidence + cfg.weights.verification * verification + cfg.weights.usage * usage + cfg.weights.architecture * architecture
    ));
    return { total, factors: { semantic, symbolic, recency, accessRecency, confidence, verification, usage, architecture, speculativePenalty, stalePenalty }, policy: cfg.type };
  }

  consolidate(options = {}) {
    const at = this.clock();
    if (!options.force && at - this.lastConsolidatedAt < this.options.consolidationIntervalMs) return { skipped: true, reason: "interval not reached", decisions: [] };
    this.lastConsolidatedAt = at;
    const decisions = [];
    decisions.push(...this.semanticDeduplicate());
    decisions.push(...this.resolveContradictions());
    decisions.push(...this.extractInvariants());
    decisions.push(...this.createCrossLinks());
    for (const type of Object.keys(MEMORY_TYPES)) decisions.push(...this.compact(type));
    this.audit.push({ at, action: "consolidate", decisions });
    return { skipped: false, decisions };
  }

  semanticDeduplicate() {
    const decisions = [];
    const list = Array.from(this.entries.values());
    const removed = new Set();
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      if (removed.has(a.id) || removed.has(b.id) || a.type !== b.type) continue;
      if (semanticOverlap(a.text(), b.text()) < 0.91) continue;
      const keep = rankTruth(a) >= rankTruth(b) ? a : b;
      const drop = keep === a ? b : a;
      keep.confidence = clamp01(Math.max(keep.confidence, drop.confidence) + 0.04);
      keep.links = mergeLinks(keep.links, drop.links);
      keep.supersedes = uniq([...keep.supersedes, drop.id, ...drop.supersedes]);
      this.entries.delete(drop.id); removed.add(drop.id);
      decisions.push({ action: "deduplicate", kept: keep.id, removed: drop.id, reason: "high semantic overlap", similarity: semanticOverlap(a.text(), b.text()) });
    }
    return decisions;
  }

  resolveContradictions() {
    const decisions = [];
    const list = Array.from(this.entries.values());
    for (const a of list) for (const b of list) {
      if (a.id >= b.id || !this.entries.has(a.id) || !this.entries.has(b.id)) continue;
      const contradict = a.contradicts.includes(b.id) || b.contradicts.includes(a.id) || (a.type === b.type && semanticOverlap(a.text(), b.text()) > 0.56 && polarity(a.content) * polarity(b.content) < 0);
      if (!contradict) continue;
      const winner = rankTruth(a) >= rankTruth(b) ? a : b;
      const loser = winner === a ? b : a;
      if (rankTruth(winner) - rankTruth(loser) > 0.15) {
        loser.verification = "contradicted";
        loser.confidence = Math.min(loser.confidence, 0.12);
        this.entries.delete(loser.id);
        decisions.push({ action: "contradiction-pruned", kept: winner.id, removed: loser.id, reason: "higher verification/confidence/provenance rank" });
      } else {
        a.metadata.needsReview = true; b.metadata.needsReview = true;
        decisions.push({ action: "contradiction-flagged", entries: [a.id, b.id], reason: "similar truth rank requires review" });
      }
    }
    return decisions;
  }

  extractInvariants() {
    const decisions = [];
    const candidates = Array.from(this.entries.values()).filter((e) => e.type === "episodic" && (e.verification === "verified" || e.confidence > 0.72));
    const groups = new Map();
    for (const e of candidates) {
      const key = e.symbols[0] || e.paths[0] || e.tags.find((t) => ARCH_TAGS.has(t));
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    for (const [key, items] of groups) {
      if (items.length < 2) continue;
      const common = commonTokens(items.map((e) => e.content)).filter((t) => t.length > 3).slice(0, 8);
      if (!common.length) continue;
      const content = `Invariant inferred from repeated verified episodes about ${key}: ${common.join(" ")}. Evidence: ${items.map((e) => e.id).join(", ")}`;
      const exists = Array.from(this.entries.values()).some((e) => e.type === "semantic" && semanticOverlap(e.content, content) > 0.80);
      if (exists) continue;
      const semantic = this.remember({ type: "semantic", kind: "extracted-invariant", title: `Invariant: ${key}`, content, tags: ["invariant", "architecture"], symbols: [key], confidence: Math.min(0.82, avg(items.map((e) => e.confidence))), verification: "inferred", provenance: { source: "consolidation", evidence: items.map((e) => e.id) }, architectureWeight: 0.92 });
      if (semantic.accepted) {
        for (const e of items) this.link(e.id, semantic.entry.id, "evidence-for");
        decisions.push({ action: "invariant-extracted", created: semantic.entry.id, evidence: items.map((e) => e.id) });
      }
    }
    return decisions;
  }

  createCrossLinks() {
    const decisions = [];
    const list = Array.from(this.entries.values());
    const pairs = [["episodic", "semantic"], ["semantic", "procedural"], ["strategic", "semantic"]];
    for (const [fromType, toType] of pairs) {
      for (const from of list.filter((e) => e.type === fromType)) {
        const best = list.filter((e) => e.type === toType).map((to) => {
          const sharedSymbols = from.symbols.filter((s) => to.symbols.includes(s)).length;
          const sharedPaths = from.paths.filter((p) => to.paths.includes(p)).length;
          const architectureBridge = fromType === "strategic" && toType === "semantic" ? from.architectureWeight * to.architectureWeight * 0.18 : 0;
          return { to, sim: clamp01(semanticOverlap(from.text(), to.text()) + sharedSymbols * 0.18 + sharedPaths * 0.12 + architectureBridge) };
        }).sort((a, b) => b.sim - a.sim)[0];
        const threshold = fromType === "strategic" && toType === "semantic" ? 0.22 : 0.34;
        if (best && best.sim > threshold && !from.links[toType].includes(best.to.id)) {
          from.links[toType].push(best.to.id);
          decisions.push({ action: "cross-link", from: from.id, to: best.to.id, relation: `${fromType}->${toType}`, score: best.sim });
        }
      }
    }
    return decisions;
  }

  compact(type) {
    ensureType(type);
    const cfg = MEMORY_TYPES[type];
    const at = this.clock();
    const entries = Array.from(this.entries.values()).filter((e) => e.type === type);
    const old = entries.filter((e) => at - e.updatedAt > cfg.compactAfterMs && e.verification !== "verified");
    const decisions = [];
    if (!old.length) return decisions;
    if (type === "episodic") {
      const failures = old.filter((e) => e.tags.includes("failure") || /fail|error|retry|attempt/i.test(e.content));
      if (failures.length) {
        const summary = this.remember({ type: "episodic", kind: "compacted-execution-history", title: "Compacted debugging history", content: failures.map((e) => `- ${firstSentence(e.content)}`).join("\n"), tags: ["compacted", "debugging"], confidence: avg(failures.map((e) => e.confidence)) * 0.85, verification: "inferred", provenance: { source: "compaction", evidence: failures.map((e) => e.id) } });
        for (const e of failures) if (this.entries.delete(e.id)) decisions.push({ action: "compact-remove", type, removed: e.id, summary: summary.entry.id });
      }
    } else {
      const summaries = old.filter((e) => this.score(e, { query: "", at, filters: {}, dependencyFocus: [], architectureFocus: 0.5, symbolicScore: 0.5 }).total < 0.34);
      for (const e of summaries) {
        e.content = firstSentence(e.content);
        e.kind = `compacted-${e.kind}`;
        e.confidence *= 0.92;
        e.updatedAt = at;
        decisions.push({ action: "compact-shrink", type, id: e.id, reason: "low score and old" });
      }
    }
    return decisions;
  }

  forget(options = {}) {
    const at = this.clock();
    const removed = [];
    for (const entry of Array.from(this.entries.values())) {
      const cfg = MEMORY_TYPES[entry.type];
      const score = this.score(entry, { query: options.query || "", at, filters: {}, dependencyFocus: [], architectureFocus: 0.3, symbolicScore: 0.2 });
      const staleDebug = entry.type === "episodic" && (entry.tags.includes("debugging") || entry.tags.includes("failure")) && at - entry.updatedAt > cfg.compactAfterMs * 2 && entry.verification !== "verified";
      const speculativeDecay = entry.speculative && score.total < cfg.forgetBelow * 1.8;
      const contradiction = entry.verification === "contradicted";
      if (contradiction || staleDebug || speculativeDecay || score.total < cfg.forgetBelow) {
        this.entries.delete(entry.id);
        removed.push({ id: entry.id, type: entry.type, title: entry.title, reason: contradiction ? "contradiction pruning" : staleDebug ? "stale debugging data removal" : speculativeDecay ? "speculative memory decay" : "below type forgetting threshold", score });
      }
    }
    this.audit.push({ at, action: "forget", removed });
    return { removed };
  }

  lineage(id, seen = new Set()) {
    const entry = this.entries.get(id);
    if (!entry || seen.has(id)) return { id, missing: !entry };
    seen.add(id);
    const linkedIds = Object.values(entry.links).flat();
    return { id, type: entry.type, title: entry.title, provenance: entry.provenance, supersedes: entry.supersedes, contradicts: entry.contradicts, links: linkedIds.map((x) => this.lineage(x, seen)) };
  }

  metrics() {
    const at = this.clock();
    const byType = {};
    for (const type of Object.keys(MEMORY_TYPES)) {
      const entries = Array.from(this.entries.values()).filter((e) => e.type === type);
      byType[type] = { entries: entries.length, averageConfidence: avg(entries.map((e) => e.confidence)), verified: entries.filter((e) => e.verification === "verified").length, speculative: entries.filter((e) => e.speculative).length, averageArchitectureWeight: avg(entries.map((e) => e.architectureWeight)), stale: entries.filter((e) => at - e.updatedAt > MEMORY_TYPES[type].compactAfterMs).length };
    }
    return { totalEntries: this.entries.size, byType, auditEvents: this.audit.length, lastConsolidatedAt: this.lastConsolidatedAt };
  }

  save(file) {
    const retention = [...this.dedupeExact(), ...this.boundByCount()];
    if (retention.length) this.audit.push({ at: this.clock(), action: "retention", decisions: retention });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Rewrite atomically: this store is several megabytes in steady state, and
    // a partial write would destroy live memory instead of just failing.
    const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify({ version: 1, savedAt: this.clock(), lastConsolidatedAt: this.lastConsolidatedAt, entries: Array.from(this.entries.values()).map((e) => e.toJSON()), audit: this.audit.slice(-500) }, null, 2), { mode: 0o600 });
      fs.renameSync(temporary, file);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch {}
      throw error;
    }
  }

  static load(file, options = {}) {
    const mem = new CognitiveMemory(options);
    if (!fs.existsSync(file)) return mem;
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    mem.lastConsolidatedAt = raw.lastConsolidatedAt || 0;
    mem.audit = raw.audit || [];
    for (const item of raw.entries || []) mem.entries.set(item.id, new MemoryEntry(item, mem.clock));
    return mem;
  }
}

function symbolicMatch(entry, filters, dependencyFocus) {
  const reasons = [];
  let score = 0.25;
  if (filters.tags && filters.tags.length) {
    const hits = entry.tags.filter((t) => filters.tags.includes(t)).length;
    if (!hits) return { pass: false, score: 0, reasons: ["missing required tag"] };
    score += Math.min(0.35, hits / filters.tags.length * 0.35); reasons.push(`tag hits ${hits}/${filters.tags.length}`);
  }
  if (filters.symbols && filters.symbols.length) {
    const hits = entry.symbols.filter((s) => filters.symbols.includes(s)).length;
    if (!hits) return { pass: false, score: 0, reasons: ["missing required symbol"] };
    score += Math.min(0.30, hits / filters.symbols.length * 0.30); reasons.push(`symbol hits ${hits}/${filters.symbols.length}`);
  }
  if (filters.paths && filters.paths.length) {
    const hits = entry.paths.filter((p) => filters.paths.includes(p)).length;
    if (!hits) return { pass: false, score: 0, reasons: ["missing required path"] };
    score += Math.min(0.25, hits / filters.paths.length * 0.25); reasons.push(`path hits ${hits}/${filters.paths.length}`);
  }
  if (dependencyFocus.length) {
    const hits = [...entry.paths, ...entry.symbols, ...entry.tags].filter((x) => dependencyFocus.includes(x)).length;
    score += Math.min(0.20, hits / dependencyFocus.length * 0.20); if (hits) reasons.push(`dependency focus hits ${hits}`);
  }
  return { pass: true, score: clamp01(score), reasons };
}

function explainScore(entry, score, symbolicReasons) {
  const top = Object.entries(score.factors).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`).join(", ");
  return `${entry.type} retrieval via ${score.policy} policy; ${top}${symbolicReasons.length ? `; symbolic: ${symbolicReasons.join(", ")}` : ""}`;
}
function polarity(text) {
  const s = normalize(text);
  const pos = /\b(must|should|required|enabled|use|allow|verified|passed|success)\b/.test(s) ? 1 : 0;
  const neg = /\b(must not|should not|never|disabled|avoid|failed|failure|contradict|do not)\b/.test(s) ? -1 : 0;
  return pos + neg || 1;
}
function rankTruth(e) { return (VERIFICATION_SCORE[e.verification] ?? 0.5) * 0.45 + e.confidence * 0.30 + Math.min(0.15, e.usageFrequency / 100) + (e.provenance.source === "test" || e.provenance.source === "user" ? 0.10 : 0); }
function mergeLinks(a, b) { return { episodic: uniq([...a.episodic, ...b.episodic]), semantic: uniq([...a.semantic, ...b.semantic]), procedural: uniq([...a.procedural, ...b.procedural]), strategic: uniq([...a.strategic, ...b.strategic]) }; }
function commonTokens(texts) {
  const sets = texts.map(tokenSet);
  if (!sets.length) return [];
  return [...sets[0]].filter((t) => sets.every((s) => s.has(t)));
}

module.exports = { CognitiveMemory, MemoryEntry, MEMORY_TYPES, DEFAULT_MAX_BY_TYPE, semanticOverlap, estimateTokens };
