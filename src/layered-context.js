"use strict";

/**
 * Structured cognitive context architecture for Pi-style harnesses.
 * This is intentionally not a vector store: all retention, scoring, packing,
 * compaction, and integrity decisions are explicit, inspectable, and layer-aware.
 */

const LAYERS = Object.freeze({
  L0: {
    id: "L0",
    name: "operating-principles",
    description: "Immutable operating principles, permanent system rules, core behavioral constraints",
    defaultTTL: Infinity,
    minBudgetRatio: 0.08,
    baseWeight: 10,
    protected: true,
    compactable: false,
  },
  L1: {
    id: "L1",
    name: "project-constitution",
    description: "Architecture memory, invariants, API contracts, coding standards, project constitution",
    defaultTTL: Infinity,
    minBudgetRatio: 0.22,
    baseWeight: 8,
    protected: true,
    compactable: true,
  },
  L2: {
    id: "L2",
    name: "active-task-state",
    description: "Current objectives, active bug investigations, active refactor plans",
    defaultTTL: 7 * 24 * 60 * 60 * 1000,
    minBudgetRatio: 0.20,
    baseWeight: 6,
    protected: false,
    compactable: true,
  },
  L3: {
    id: "L3",
    name: "working-set",
    description: "Open files, recent tool outputs, short-horizon reasoning",
    defaultTTL: 24 * 60 * 60 * 1000,
    minBudgetRatio: 0.10,
    baseWeight: 4,
    protected: false,
    compactable: true,
  },
  L4: {
    id: "L4",
    name: "scratchpad",
    description: "Temporary exploration, speculative reasoning, disposable context",
    defaultTTL: 2 * 60 * 60 * 1000,
    minBudgetRatio: 0,
    baseWeight: 1,
    protected: false,
    compactable: true,
  },
});

const VERIFICATION_WEIGHT = Object.freeze({ verified: 1, assumed: 0.62, contradicted: 0, stale: 0.2 });
const ARCHITECTURAL_TAGS = new Set(["architecture", "invariant", "api", "contract", "constitution", "coding-standard", "principle", "constraint"]);

function now() { return Date.now(); }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function estimateTokens(text) { return Math.max(1, Math.ceil(String(text || "").length / 4)); }
function normalizeText(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function tokenize(text) { return new Set(normalizeText(text).split(/\s+/).filter(Boolean)); }
function overlapScore(a, b) {
  const A = tokenize(a); const B = tokenize(b);
  if (!A.size || !B.size) return 0;
  let overlap = 0;
  for (const token of A) if (B.has(token)) overlap++;
  return overlap / Math.sqrt(A.size * B.size);
}
function stableId(block) {
  const raw = `${block.layer}:${block.kind || "memory"}:${normalizeText(block.title || block.content).slice(0, 120)}`;
  let h = 2166136261;
  for (let i = 0; i < raw.length; i++) { h ^= raw.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `ctx_${(h >>> 0).toString(16)}`;
}

class ContextBlock {
  constructor(input, clock = now) {
    if (!LAYERS[input.layer]) throw new Error(`Unknown context layer: ${input.layer}`);
    this.layer = input.layer;
    this.title = input.title || input.kind || "context";
    this.content = String(input.content || "");
    this.kind = input.kind || "memory";
    this.tags = Array.from(new Set(input.tags || []));
    this.createdAt = input.createdAt || clock();
    this.updatedAt = input.updatedAt || this.createdAt;
    this.lastAccessedAt = input.lastAccessedAt || this.updatedAt;
    this.accessCount = input.accessCount || 0;
    this.ttlMs = input.ttlMs ?? LAYERS[input.layer].defaultTTL;
    this.importance = clamp01(input.importance ?? 0.5);
    this.architecturalImportance = clamp01(input.architecturalImportance ?? (this.tags.some((t) => ARCHITECTURAL_TAGS.has(t)) ? 0.85 : 0.2));
    this.dependencyRefs = Array.from(new Set(input.dependencyRefs || []));
    this.verification = input.verification || "assumed";
    this.protected = Boolean(input.protected ?? LAYERS[input.layer].protected);
    this.source = input.source || "unknown";
    this.id = input.id || stableId(this);
    this.supersedes = Array.from(new Set(input.supersedes || []));
    this.contradicts = Array.from(new Set(input.contradicts || []));
    this.metadata = { ...(input.metadata || {}) };
  }

  get tokenEstimate() { return estimateTokens(`${this.title}\n${this.content}`); }
  isExpired(at = now()) { return Number.isFinite(this.ttlMs) && at - this.updatedAt > this.ttlMs; }
  touch(at = now()) { this.lastAccessedAt = at; this.accessCount += 1; }
}

class LayeredContextMemory {
  constructor(options = {}) {
    this.clock = options.clock || now;
    this.layers = options.layers || LAYERS;
    this.blocks = new Map();
    this.audit = [];
  }

  upsert(input) {
    const block = input instanceof ContextBlock ? input : new ContextBlock(input, this.clock);
    const integrity = this.checkIntegrity(block);
    if (!integrity.accepted) {
      this.audit.push({ at: this.clock(), action: "reject", blockId: block.id, reasons: integrity.reasons });
      return { accepted: false, block, integrity };
    }
    for (const duplicate of integrity.duplicates) this.remove(duplicate.id, `duplicate of ${block.id}`);
    for (const old of integrity.superseded) this.remove(old.id, `superseded by ${block.id}`);
    this.blocks.set(block.id, block);
    this.audit.push({ at: this.clock(), action: "upsert", blockId: block.id, layer: block.layer });
    return { accepted: true, block, integrity };
  }

  remove(id, reason = "removed") {
    const block = this.blocks.get(id);
    if (!block) return false;
    if (block.protected && reason !== "superseded by verified replacement") {
      this.audit.push({ at: this.clock(), action: "protect", blockId: id, reason });
      return false;
    }
    this.blocks.delete(id);
    this.audit.push({ at: this.clock(), action: "remove", blockId: id, layer: block.layer, reason });
    return true;
  }

  checkIntegrity(candidate) {
    const reasons = [];
    const duplicates = [];
    const superseded = [];
    const conflicts = [];
    const normalizedCandidate = normalizeText(candidate.content);

    for (const block of this.blocks.values()) {
      if (block.id === candidate.id) continue;
      const sim = overlapScore(candidate.title + " " + candidate.content, block.title + " " + block.content);
      if (candidate.layer === block.layer && sim > 0.94) duplicates.push(block);
      if (candidate.supersedes.includes(block.id)) superseded.push(block);
      if (candidate.contradicts.includes(block.id) || block.contradicts.includes(candidate.id)) conflicts.push(block);
      if (candidate.layer === "L1" && block.layer === "L1" && sim > 0.72 && normalizedCandidate.includes("must") && normalizeText(block.content).includes("must not")) conflicts.push(block);
    }

    if (conflicts.some((b) => b.protected) && candidate.verification !== "verified") {
      reasons.push("unverified candidate conflicts with protected memory");
    }
    if (candidate.layer === "L0" && !candidate.protected) reasons.push("L0 blocks must be protected");
    if (candidate.verification === "contradicted") reasons.push("contradicted memory cannot be inserted");

    return { accepted: reasons.length === 0, reasons, duplicates, superseded, conflicts };
  }

  semanticScore(block, query = "", at = this.clock(), dependencyFocus = []) {
    const ageMs = Math.max(0, at - block.updatedAt);
    const sinceAccessMs = Math.max(0, at - block.lastAccessedAt);
    const ttl = Number.isFinite(block.ttlMs) ? block.ttlMs : 365 * 24 * 60 * 60 * 1000;
    const recency = clamp01(1 - ageMs / ttl);
    const accessFrequency = clamp01(Math.log1p(block.accessCount) / Math.log(20));
    const dependencyRelevance = dependencyFocus.length
      ? clamp01(block.dependencyRefs.filter((r) => dependencyFocus.includes(r)).length / dependencyFocus.length)
      : clamp01(block.dependencyRefs.length ? 0.35 : 0.15);
    const architecturalImportance = block.architecturalImportance;
    const verification = VERIFICATION_WEIGHT[block.verification] ?? 0.5;
    const queryRelevance = query ? overlapScore(query, `${block.title}\n${block.content}\n${block.tags.join(" ")}`) : 0.35;
    const accessRecency = clamp01(1 - sinceAccessMs / ttl);
    const layerWeight = this.layers[block.layer].baseWeight / 10;
    const score = clamp01(
      0.18 * recency +
      0.12 * accessFrequency +
      0.14 * dependencyRelevance +
      0.18 * architecturalImportance +
      0.16 * verification +
      0.16 * queryRelevance +
      0.06 * accessRecency
    ) * (0.65 + 0.35 * layerWeight);
    return {
      total: block.protected ? Math.max(score, 0.82) : score,
      factors: { recency, accessFrequency, dependencyRelevance, architecturalImportance, verification, queryRelevance, accessRecency, layerWeight },
      expired: block.isExpired(at),
    };
  }

  compactLayer(layerId, options = {}) {
    const at = this.clock();
    const candidates = Array.from(this.blocks.values()).filter((b) => b.layer === layerId && this.layers[layerId].compactable && !b.protected);
    const removed = [];
    const invariantLines = [];
    const summaries = [];
    const seen = new Set();

    for (const block of candidates) {
      const score = this.semanticScore(block, options.query || "", at, options.dependencyFocus || []);
      const stale = score.expired || score.total < (options.threshold ?? 0.25);
      if (!stale) continue;
      if (block.tags.some((t) => ARCHITECTURAL_TAGS.has(t)) || block.architecturalImportance > 0.7) {
        invariantLines.push(`- ${block.title}: ${firstSentence(block.content)}`);
      } else if (block.verification !== "contradicted") {
        const sentence = firstSentence(block.content);
        const key = normalizeText(sentence);
        if (sentence && !seen.has(key)) { summaries.push(`- ${block.title}: ${sentence}`); seen.add(key); }
      }
      if (this.remove(block.id, `compacted from ${layerId}`)) removed.push(block.id);
    }

    const created = [];
    if (invariantLines.length) {
      created.push(this.upsert({ layer: "L1", kind: "extracted-invariant", title: `Extracted invariants from ${layerId}`, content: invariantLines.join("\n"), tags: ["invariant", "compacted"], importance: 0.8, architecturalImportance: 0.9, verification: "assumed", source: "compaction" }).block.id);
    }
    if (summaries.length) {
      const targetLayer = layerId === "L4" ? "L3" : layerId;
      created.push(this.upsert({ layer: targetLayer, kind: "semantic-summary", title: `Compacted ${layerId} summary`, content: summaries.join("\n"), tags: ["summary", "compacted"], importance: 0.45, verification: "assumed", source: "compaction" }).block.id);
    }
    this.audit.push({ at, action: "compact", layer: layerId, removed, created });
    return { removed, created };
  }

  pack({ tokenBudget, query = "", dependencyFocus = [], includeScratch = true } = {}) {
    if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) throw new Error("tokenBudget must be positive");
    const at = this.clock();
    const all = Array.from(this.blocks.values()).filter((b) => includeScratch || b.layer !== "L4");
    const scored = all.map((block) => ({ block, score: this.semanticScore(block, query, at, dependencyFocus) }));
    const included = [];
    const removed = [];
    const allocations = allocateBudgets(tokenBudget, this.layers, scored);
    const usedByLayer = Object.fromEntries(Object.keys(this.layers).map((id) => [id, 0]));

    for (const layerId of Object.keys(this.layers)) {
      const layerItems = scored
        .filter((x) => x.block.layer === layerId)
        .sort((a, b) => Number(b.block.protected) - Number(a.block.protected) || b.score.total - a.score.total || a.block.tokenEstimate - b.block.tokenEstimate);
      for (const item of layerItems) {
        const tokens = item.block.tokenEstimate;
        const protectedOverflow = item.block.protected && this.layers[layerId].protected;
        const fits = usedByLayer[layerId] + tokens <= allocations[layerId] || protectedOverflow;
        if (item.score.expired && !item.block.protected) {
          removed.push(removal(item, "expired by layer TTL"));
        } else if (fits && totalTokens(included) + tokens <= tokenBudget) {
          included.push({ block: item.block, score: item.score, tokens, why: inclusionReason(item, allocations[layerId], usedByLayer[layerId]) });
          usedByLayer[layerId] += tokens;
          item.block.touch(at);
        } else if (item.block.protected) {
          included.push({ block: item.block, score: item.score, tokens, why: "protected invariant admitted before lower priority context" });
          usedByLayer[layerId] += tokens;
          item.block.touch(at);
        } else {
          removed.push(removal(item, "lower score than selected blocks within token allocation"));
        }
      }
    }

    let packed = included.sort((a, b) => layerOrder(a.block.layer) - layerOrder(b.block.layer) || b.score.total - a.score.total);
    while (totalTokens(packed) > tokenBudget) {
      const idx = findEvictionIndex(packed);
      if (idx < 0) break;
      const [evicted] = packed.splice(idx, 1);
      removed.push({ id: evicted.block.id, layer: evicted.block.layer, title: evicted.block.title, tokens: evicted.tokens, reason: "global budget overflow", score: evicted.score });
    }

    const tokenUse = totalTokens(packed);
    return {
      blocks: packed.map((x) => x.block),
      text: packed.map((x) => formatBlock(x.block)).join("\n\n"),
      observations: {
        included: packed.map((x) => ({ id: x.block.id, layer: x.block.layer, title: x.block.title, tokens: x.tokens, why: x.why, score: x.score })),
        removed,
        allocations,
        usedByLayer,
        tokenBudget,
        tokenUse,
      },
    };
  }

  metrics(query = "") {
    const at = this.clock();
    const blocks = Array.from(this.blocks.values());
    const byLayer = {};
    for (const layerId of Object.keys(this.layers)) {
      const items = blocks.filter((b) => b.layer === layerId);
      byLayer[layerId] = {
        blocks: items.length,
        tokens: items.reduce((sum, b) => sum + b.tokenEstimate, 0),
        protected: items.filter((b) => b.protected).length,
        expired: items.filter((b) => b.isExpired(at)).length,
        averageScore: avg(items.map((b) => this.semanticScore(b, query, at).total)),
      };
    }
    return { totalBlocks: blocks.length, totalTokens: blocks.reduce((sum, b) => sum + b.tokenEstimate, 0), byLayer, auditEvents: this.audit.length };
  }
}

function firstSentence(text) { return String(text || "").replace(/\s+/g, " ").split(/(?<=[.!?])\s+/)[0].slice(0, 240); }
function avg(nums) { return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0; }
function layerOrder(layerId) { return Number(layerId.slice(1)); }
function totalTokens(items) { return items.reduce((sum, x) => sum + x.tokens, 0); }
function formatBlock(block) { return `[${block.layer}:${block.kind}] ${block.title}\n${block.content}`; }
function removal(item, reason) { return { id: item.block.id, layer: item.block.layer, title: item.block.title, tokens: item.block.tokenEstimate, reason, score: item.score }; }
function inclusionReason(item, allocation, used) {
  const f = item.score.factors;
  const drivers = Object.entries(f).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}=${v.toFixed(2)}`).join(", ");
  return `${item.block.protected ? "protected; " : ""}score=${item.score.total.toFixed(3)} (${drivers}); layer allocation ${used}/${allocation}`;
}
function findEvictionIndex(items) {
  let best = -1;
  for (let i = 0; i < items.length; i++) {
    if (items[i].block.protected) continue;
    if (best < 0 || items[i].score.total < items[best].score.total) best = i;
  }
  return best;
}
function allocateBudgets(total, layers, scored) {
  const allocations = {};
  let reserved = 0;
  for (const [id, layer] of Object.entries(layers)) {
    const hasBlocks = scored.some((x) => x.block.layer === id);
    allocations[id] = hasBlocks ? Math.floor(total * layer.minBudgetRatio) : 0;
    reserved += allocations[id];
  }
  const remaining = Math.max(0, total - reserved);
  const demand = Object.fromEntries(Object.keys(layers).map((id) => [id, scored.filter((x) => x.block.layer === id).reduce((s, x) => s + x.block.tokenEstimate * Math.max(0.05, x.score.total), 0)]));
  const demandTotal = Object.values(demand).reduce((a, b) => a + b, 0) || 1;
  for (const id of Object.keys(layers)) allocations[id] += Math.floor(remaining * demand[id] / demandTotal);
  return allocations;
}

module.exports = { LAYERS, ContextBlock, LayeredContextMemory, estimateTokens, overlapScore };
