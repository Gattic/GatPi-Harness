"use strict";

/**
 * Entropy monitoring and session-stability subsystem.
 *
 * The monitor is deterministic and local-first: every metric is computed from a
 * bounded event window, normalized to [0, 1], persisted as append-only evidence,
 * and combined with explicit weights.  Heuristics are kept inspectable and are
 * backed by measurable rates, distances, densities and loop signatures.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { sanitizeManagedDiagnosticState } = require("./managed-state-sanitizer");
const { appendBoundedJsonl, DIAGNOSTIC_POLICIES } = require("./file-integration-storage");
const { writePrivateJson } = require("./project-memory-decisions");
const crypto = require("node:crypto");

const DEFAULT_WEIGHTS = Object.freeze({
  contextGrowthRate: 0.10,
  retryDepth: 0.10,
  contradictionFrequency: 0.14,
  patchInstability: 0.11,
  patchReversionFrequency: 0.09,
  hallucinatedToolCalls: 0.08,
  verifierFailureDensity: 0.12,
  semanticDrift: 0.10,
  branchDivergence: 0.08,
  tokenInefficiency: 0.08,
});

const DEFAULT_THRESHOLDS = Object.freeze({
  watch: 0.38,
  stabilize: 0.55,
  branch: 0.68,
  isolate: 0.72,
  reset: 0.78,
  critical: 0.86,
});

const STOP = new Set("a an and are as at be by for from has have in into is it its of on or that the this to via was were will with without must should can could would only over under than then about after before current recent".split(" "));

function now() { return Date.now(); }
function iso(t = now()) { return new Date(t).toISOString(); }
function clamp01(n) { return Math.max(0, Math.min(1, Number.isFinite(n) ? n : 0)); }
function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
function avg(xs) { return xs.length ? sum(xs) / xs.length : 0; }
function uniq(xs) { return Array.from(new Set((xs || []).filter(Boolean))); }
function ensureDir(fileOrDir) { fs.mkdirSync(path.extname(fileOrDir) ? path.dirname(fileOrDir) : fileOrDir, { recursive: true }); }
function stableStringify(value) {
  if (value == null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex"); }
function estimateTokens(text) { return Math.max(1, Math.ceil(String(text || "").length / 4)); }
function normalize(text) { return String(text || "").toLowerCase().replace(/[^a-z0-9_./:-]+/g, " ").trim(); }
function tokens(text) { return normalize(text).split(/\s+/).filter((t) => t && !STOP.has(t)); }
function tokenSet(text) { return new Set(tokens(text)); }
function cosineText(a, b) {
  const A = tokens(a); const B = tokens(b);
  if (!A.length || !B.length) return 0;
  const ma = new Map(); const mb = new Map();
  for (const t of A) ma.set(t, (ma.get(t) || 0) + 1);
  for (const t of B) mb.set(t, (mb.get(t) || 0) + 1);
  let dot = 0; for (const [t, v] of ma) dot += v * (mb.get(t) || 0);
  const na = Math.sqrt(sum(Array.from(ma.values()).map((v) => v * v)));
  const nb = Math.sqrt(sum(Array.from(mb.values()).map((v) => v * v)));
  return na && nb ? dot / (na * nb) : 0;
}
function jaccard(a, b) {
  const A = a instanceof Set ? a : tokenSet(a); const B = b instanceof Set ? b : tokenSet(b);
  const union = new Set([...A, ...B]); if (!union.size) return 0;
  let hit = 0; for (const t of A) if (B.has(t)) hit++;
  return hit / union.size;
}
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function writeJson(file, value) { writePrivateJson(file, value); }

class OnlineStats {
  constructor() { this.n = 0; this.mean = 0; this.m2 = 0; }
  push(x) { this.n++; const d = x - this.mean; this.mean += d / this.n; this.m2 += d * (x - this.mean); return this; }
  get variance() { return this.n > 1 ? this.m2 / (this.n - 1) : 0; }
  get stdev() { return Math.sqrt(this.variance); }
  z(x) { return this.stdev ? (x - this.mean) / this.stdev : 0; }
  toJSON() { return { n: this.n, mean: this.mean, variance: this.variance, stdev: this.stdev }; }
}

class EntropyMetrics {
  constructor(options = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...(options.weights || {}) };
    const total = sum(Object.values(this.weights)) || 1;
    for (const k of Object.keys(this.weights)) this.weights[k] /= total;
    this.stats = Object.fromEntries(Object.keys(this.weights).map((k) => [k, new OnlineStats()]));
    this.history = [];
    this.maxHistory = options.maxHistory || 1000;
  }
  score(metrics) {
    let entropy = 0;
    for (const [k, w] of Object.entries(this.weights)) entropy += w * clamp01(metrics[k] || 0);
    entropy = clamp01(entropy);
    const prev = this.history[this.history.length - 1];
    const derivative = prev ? entropy - prev.entropyScore : 0;
    const acceleration = this.history.length > 1 ? derivative - (prev.entropyDerivative || 0) : 0;
    const contradiction = metrics.contradictionFrequency || 0;
    const drift = metrics.semanticDrift || 0;
    const verifier = metrics.verifierFailureDensity || 0;
    const retry = metrics.retryDepth || 0;
    const patch = Math.max(metrics.patchInstability || 0, metrics.patchReversionFrequency || 0);
    const loop = metrics.recursiveFailureScore || 0;
    const stabilityScore = clamp01(1 - (0.72 * entropy + 0.16 * Math.max(0, derivative) + 0.12 * loop));
    const coherenceScore = clamp01(1 - (0.42 * contradiction + 0.28 * drift + 0.16 * (metrics.branchDivergence || 0) + 0.14 * (metrics.duplicationPressure || 0)));
    const confidenceScore = clamp01(1 - (0.34 * verifier + 0.22 * retry + 0.18 * patch + 0.16 * contradiction + 0.10 * (metrics.hallucinatedToolCalls || 0)));
    const scored = { ...metrics, entropyScore: entropy, entropyDerivative: derivative, entropyAcceleration: acceleration, stabilityScore, coherenceScore, confidenceScore };
    for (const k of Object.keys(this.stats)) this.stats[k].push(metrics[k] || 0);
    this.history.push(scored); this.history = this.history.slice(-this.maxHistory);
    return scored;
  }
  snapshot() { return { weights: this.weights, stats: Object.fromEntries(Object.entries(this.stats).map(([k, v]) => [k, v.toJSON()])), history: this.history.slice() }; }
}

class ContradictionDetector {
  constructor(options = {}) {
    this.assumptions = [];
    this.plans = [];
    this.objectives = [];
    this.architecture = [];
    this.maxItems = options.maxItems || 600;
  }
  observe(event) {
    const item = normalizeKnowledgeEvent(event);
    if (!item) return [];
    const target = item.kind === "plan" ? this.plans : item.kind === "objective" ? this.objectives : item.kind === "architecture" ? this.architecture : this.assumptions;
    const contradictions = this.detectAgainst(item, [...this.assumptions, ...this.plans, ...this.architecture]);
    const duplicates = item.kind === "objective" ? this.detectDuplicateObjectives(item) : [];
    target.push(item); target.splice(0, Math.max(0, target.length - this.maxItems));
    return [...contradictions, ...duplicates];
  }
  detectAgainst(item, existing) {
    const out = [];
    for (const other of existing) {
      if (other.id === item.id) continue;
      const relation = contradictionRelation(item, other);
      if (relation) out.push({ id: `contr_${hash({ a: item.id, b: other.id, relation }).slice(0, 12)}`, type: relation.type, severity: relation.severity, a: item, b: other, explanation: relation.explanation });
    }
    return out;
  }
  detectDuplicateObjectives(item) {
    const out = [];
    for (const other of this.objectives) {
      const sim = cosineText(item.text, other.text);
      if (sim > 0.88) out.push({ id: `dup_${hash({ a: item.id, b: other.id }).slice(0, 12)}`, type: "duplicated-objective", severity: 0.35 + 0.5 * sim, a: item, b: other, explanation: `objective similarity ${sim.toFixed(3)}` });
    }
    return out;
  }
  cleanup(resolutions = []) {
    const remove = new Set(resolutions.flatMap((r) => [r.removeId, ...(r.removeIds || [])]).filter(Boolean));
    const mark = (xs) => xs.filter((x) => !remove.has(x.id));
    this.assumptions = mark(this.assumptions); this.plans = mark(this.plans); this.objectives = mark(this.objectives); this.architecture = mark(this.architecture);
  }
  all() { return [...this.assumptions, ...this.plans, ...this.objectives, ...this.architecture]; }
}

class RecursiveFailureDetector {
  constructor(options = {}) { this.window = []; this.maxWindow = options.maxWindow || 120; }
  observe(event) { this.window.push(event); this.window = this.window.slice(-this.maxWindow); return this.analyze(); }
  analyze() {
    const failures = this.window.filter((e) => e.ok === false || /fail|error|rollback/i.test(e.type || ""));
    const retries = this.window.filter((e) => /retry|attempt/i.test(e.type || "") || e.retry === true);
    const signatures = this.window.map(eventSignature);
    const counts = new Map(); for (const s of signatures) counts.set(s, (counts.get(s) || 0) + 1);
    const maxRepeat = Math.max(0, ...counts.values());
    const cyclicPlanning = repeatedNgrams(signatures, 3) + repeatedNgrams(signatures, 4);
    const failedRetries = retries.filter((e) => e.ok === false).length;
    const patchHashes = this.window.filter((e) => e.type === "patch" || e.patchHash).map((e) => e.patchHash || hash(e.patch || e.diff || e));
    const unstablePatchGeneration = repeatedAlternation(patchHashes);
    const loopingReasoning = clamp01((maxRepeat - 2) / 6 + cyclicPlanning / 10);
    const score = clamp01(0.32 * clamp01(failedRetries / 5) + 0.28 * loopingReasoning + 0.22 * clamp01(unstablePatchGeneration / 4) + 0.18 * clamp01(failures.length / Math.max(1, this.window.length * 0.55)));
    return { score, failedRetries, loopingReasoning, cyclicPlanning, unstablePatchGeneration, maxRepeat };
  }
}

class ContextSanitizer {
  constructor(options = {}) { this.now = options.clock || now; }
  sanitize(blocks, options = {}) {
    const at = this.now();
    const maxAgeMs = options.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const protectedTags = new Set(options.protectedTags || ["architecture", "invariant", "constitution", "verified"]);
    const seen = [];
    const removed = [];
    const isolated = [];
    const kept = [];
    const contradictions = options.contradictions || [];
    const contradictedIds = new Set(contradictions.flatMap((c) => [c.a?.id, c.b?.id]).filter(Boolean));
    for (const raw of blocks || []) {
      const b = { ...raw, content: String(raw.content || raw.text || "") };
      const tags = new Set(b.tags || []);
      const protectedBlock = b.protected || Array.from(tags).some((t) => protectedTags.has(t));
      const stale = !protectedBlock && b.updatedAt != null && at - b.updatedAt > maxAgeMs;
      const speculative = b.speculative || b.verification === "speculative" || tags.has("speculative");
      const contradicted = contradictedIds.has(b.id) || b.verification === "contradicted";
      const redundant = seen.some((x) => cosineText(`${x.title}\n${x.content}`, `${b.title}\n${b.content}`) > 0.94);
      if (stale) { removed.push({ ...b, sanitationReason: "stale" }); continue; }
      if (redundant && !protectedBlock) { removed.push({ ...b, sanitationReason: "redundant" }); continue; }
      if (speculative || contradicted) { isolated.push({ ...b, isolated: true, sanitationReason: speculative ? "speculative" : "contradicted" }); continue; }
      kept.push(b); seen.push(b);
    }
    return { kept, isolated, removed, summary: { kept: kept.length, isolated: isolated.length, removed: removed.length } };
  }
  compact(blocks, budgetTokens = 4000) {
    const ranked = (blocks || []).map((b) => ({ ...b, _tokens: estimateTokens(`${b.title || ""}\n${b.content || b.text || ""}`), _score: contextImportance(b) })).sort((a, b) => b._score - a._score);
    const kept = []; let used = 0;
    for (const b of ranked) if (used + b._tokens <= budgetTokens || b.protected) { kept.push(stripPrivate(b)); used += b._tokens; }
    return { blocks: kept, usedTokens: used, dropped: Math.max(0, ranked.length - kept.length) };
  }
}

class StabilizationEngine {
  constructor(options = {}) { this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds || {}) }; this.sanitizer = options.sanitizer || new ContextSanitizer(options); }
  recommend(state, contextBlocks = []) {
    const m = state.metrics || state;
    const actions = [];
    if (m.entropyScore >= this.thresholds.watch || m.contextGrowthRate > 0.55 || m.tokenInefficiency > 0.55) actions.push({ type: "compact_context", priority: priority(m.entropyScore), reason: "context/token entropy rising" });
    if (m.entropyScore >= this.thresholds.branch || m.branchDivergence > 0.55 || m.semanticDrift > 0.64) actions.push({ type: "branch_session", priority: priority(Math.max(m.entropyScore, m.branchDivergence, m.semanticDrift)), reason: "goal/branch divergence" });
    if (m.entropyScore >= this.thresholds.isolate || m.verifierFailureDensity > 0.62 || m.recursiveFailureScore > 0.55) actions.push({ type: "isolate_failing_agents", priority: priority(Math.max(m.verifierFailureDensity, m.recursiveFailureScore)), reason: "failure density or recursive loop" });
    if (m.entropyScore >= this.thresholds.reset || m.patchInstability > 0.72 || m.patchReversionFrequency > 0.55) actions.push({ type: "reset_volatile_memory", priority: priority(Math.max(m.patchInstability, m.patchReversionFrequency, m.entropyScore)), reason: "volatile patch state unstable" });
    if (m.recursiveFailureScore > 0.38 || m.retryDepth > 0.5) actions.push({ type: "request_failure_analysis", priority: priority(Math.max(m.recursiveFailureScore, m.retryDepth)), reason: "retry/loop signatures detected; require verifier evidence and explicit failure artifact" });
    const sanitation = this.sanitizer.sanitize(contextBlocks, { contradictions: state.contradictions || [] });
    const compaction = this.sanitizer.compact(sanitation.kept, state.contextBudgetTokens || 4000);
    return { actions, sanitation, compaction, shouldPause: m.entropyScore >= this.thresholds.critical, status: healthStatus(m) };
  }
}

class MetricsPersistence {
  constructor(options = {}) {
    this.dir = options.dir || path.join(process.cwd(), ".pi", "entropy");
    this.eventsFile = path.join(this.dir, "events.jsonl");
    this.snapshotsFile = path.join(this.dir, "snapshots.jsonl");
    this.statsFile = path.join(this.dir, "stats.json");
    this.retention = { ...DIAGNOSTIC_POLICIES.entropy, ...options.retention };
  }
  recordEvent(event) { appendBoundedJsonl(this.eventsFile, sanitizeManagedDiagnosticState(event).value, this.retention); }
  recordSnapshot(snapshot) { appendBoundedJsonl(this.snapshotsFile, sanitizeManagedDiagnosticState(snapshot).value, this.retention); writeJson(this.statsFile, summarizeSnapshots(this.loadSnapshots(1000))); }
  loadSnapshots(limit = Infinity) {
    try {
      const lines = fs.readFileSync(this.snapshotsFile, "utf8").trim().split(/\n+/).filter(Boolean);
      return lines.slice(Number.isFinite(limit) ? -limit : 0).map((l) => JSON.parse(l));
    } catch { return []; }
  }
  loadStats() { return readJson(this.statsFile, { count: 0 }); }
}

class EntropyDashboard {
  static timelines(history, width = 60) {
    return {
      entropy: sparkline(history.map((h) => h.entropyScore), width),
      stability: sparkline(history.map((h) => h.stabilityScore), width),
      coherence: sparkline(history.map((h) => h.coherenceScore), width),
      confidence: sparkline(history.map((h) => h.confidenceScore), width),
      retryHeatmap: heatmap(history.map((h) => h.retryDepth), width),
      branchDivergence: sparkline(history.map((h) => h.branchDivergence), width),
    };
  }
  static html(history, file = path.join(process.cwd(), ".pi", "entropy", "dashboard.html")) {
    ensureDir(file);
    const data = JSON.stringify(history.slice(-500));
    const content = `<!doctype html><meta charset="utf-8"><title>Pi Entropy Monitor</title><style>body{font-family:system-ui;margin:24px;background:#101418;color:#e8edf2}.card{background:#18202a;padding:16px;margin:12px 0;border-radius:10px}svg{width:100%;height:120px}path{fill:none;stroke-width:2}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}</style><h1>Session entropy diagnostics</h1><div id="app"></div><script>const H=${data};const keys=['entropyScore','stabilityScore','coherenceScore','confidenceScore','branchDivergence','retryDepth'];function pts(k){return H.map((d,i)=>[i/(Math.max(1,H.length-1))*100,100-(+(d[k]||0))*90-5]).map(p=>p.join(',')).join(' ')}document.getElementById('app').innerHTML='<div class="grid">'+keys.map((k,i)=>'<div class="card"><h3>'+k+'</h3><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="'+pts(k)+'" stroke="'+['#ff6b6b','#69db7c','#74c0fc','#ffd43b','#b197fc','#ffa94d'][i]+'" fill="none"/></svg></div>').join('')+'</div><pre>'+JSON.stringify(H[H.length-1]||{},null,2)+'</pre>';</script>`;
    fs.writeFileSync(file, content);
    return file;
  }
}

class EntropyMonitor {
  constructor(options = {}) {
    this.clock = options.clock || now;
    this.windowSize = options.windowSize || 200;
    this.allowedTools = new Set(options.allowedTools || []);
    this.events = [];
    this.contextTokens = [];
    this.patchHistory = [];
    this.branchStates = new Map();
    this.progressEvents = 0;
    this.contradictions = [];
    this.metrics = new EntropyMetrics(options);
    this.contradictionDetector = options.contradictionDetector || new ContradictionDetector(options);
    this.failureDetector = options.failureDetector || new RecursiveFailureDetector(options);
    this.stabilizer = options.stabilizer || new StabilizationEngine(options);
    this.persistence = options.persistence === false ? null : (options.persistence || new MetricsPersistence(options.persistenceOptions || {}));
    this.lastSnapshot = null;
  }
  observe(event = {}) {
    const e = normalizeEvent(event, this.clock());
    this.events.push(e); this.events = this.events.slice(-this.windowSize);
    if (this.persistence) this.persistence.recordEvent(e);
    if (e.type === "context") this.contextTokens.push({ at: e.at, tokens: e.tokens ?? estimateTokens(e.text || e.content || "") });
    if (e.type === "patch") this.patchHistory.push(e), this.patchHistory = this.patchHistory.slice(-this.windowSize);
    if (e.type === "progress" || e.ok === true && /verifier|test|task|patch/.test(e.type)) this.progressEvents++;
    const newContradictions = this.contradictionDetector.observe(e);
    this.contradictions.push(...newContradictions); this.contradictions = this.contradictions.slice(-this.windowSize);
    if (e.type === "branch") this.updateBranch(e);
    const recursive = this.failureDetector.observe(e);
    const raw = this.computeRawMetrics(recursive);
    const scored = this.metrics.score(raw);
    const stabilization = this.stabilizer.recommend({ metrics: scored, contradictions: this.contradictions, contextBudgetTokens: e.contextBudgetTokens }, e.contextBlocks || []);
    const snapshot = { id: `entropy_${hash({ at: e.at, n: this.events.length, scored }).slice(0, 12)}`, at: e.at, atIso: iso(e.at), metrics: scored, contradictions: newContradictions, recursiveFailure: recursive, stabilization };
    this.lastSnapshot = snapshot;
    if (this.persistence) this.persistence.recordSnapshot(snapshot);
    return snapshot;
  }
  computeRawMetrics(recursive) {
    const w = this.events;
    const n = Math.max(1, w.length);
    const retryDepth = clamp01(Math.max(0, ...w.map((e) => e.retryDepth || e.attempt || 0)) / 8);
    const contradictionFrequency = clamp01(this.contradictions.length / Math.max(8, n));
    const patches = w.filter((e) => e.type === "patch");
    const failedPatches = patches.filter((e) => e.ok === false || e.reverted || /fail|reject|rollback/i.test(e.status || ""));
    const patchInstability = clamp01(failedPatches.length / Math.max(1, patches.length));
    const patchReversionFrequency = clamp01(countPatchReversions(this.patchHistory) / Math.max(1, patches.length));
    const toolCalls = w.filter((e) => e.type === "tool_call");
    const hallucinatedToolCalls = clamp01(toolCalls.filter((e) => e.hallucinated || e.unknownTool || (this.allowedTools.size && !this.allowedTools.has(e.tool))).length / Math.max(1, toolCalls.length));
    const verifier = w.filter((e) => /verifier|verification|test/.test(e.type));
    const verifierFailureDensity = clamp01(verifier.filter((e) => e.ok === false).length / Math.max(1, verifier.length));
    const semanticDrift = computeSemanticDrift(w);
    const branchDivergence = computeBranchDivergence(Array.from(this.branchStates.values()));
    const tokenInefficiency = computeTokenInefficiency(w, this.progressEvents);
    const contextGrowthRate = computeContextGrowthRate(this.contextTokens);
    return { contextGrowthRate, retryDepth, contradictionFrequency, patchInstability, patchReversionFrequency, hallucinatedToolCalls, verifierFailureDensity, semanticDrift, branchDivergence, tokenInefficiency, recursiveFailureScore: recursive.score, duplicationPressure: clamp01(this.contradictions.filter((c) => c.type === "duplicated-objective").length / Math.max(4, n)) };
  }
  updateBranch(e) {
    const id = e.branchId || e.id || "main";
    const prev = this.branchStates.get(id) || { branchId: id, text: "", files: new Set(), updatedAt: e.at };
    this.branchStates.set(id, { branchId: id, text: `${prev.text}\n${e.objective || e.plan || e.text || ""}`.slice(-4000), files: new Set([...prev.files, ...(e.files || e.changedFiles || [])]), updatedAt: e.at });
  }
  health() { return this.lastSnapshot; }
  dashboards(file) { return { ascii: EntropyDashboard.timelines(this.metrics.history), html: EntropyDashboard.html(this.metrics.history, file) }; }
  persistLongTerm() { if (!this.persistence) return null; const stats = summarizeSnapshots(this.persistence.loadSnapshots(Infinity)); writeJson(this.persistence.statsFile, stats); return stats; }
}

function normalizeEvent(event, at) {
  const e = { ...event, at: event.at || event.timestamp || at };
  e.type = e.type || inferEventType(e);
  if (e.text == null && e.content != null) e.text = e.content;
  if (e.tokens == null && e.text) e.tokens = estimateTokens(e.text);
  if (e.type === "patch" && !e.patchHash) e.patchHash = hash(e.patch || e.diff || e.after || e.text || e.id || e);
  return e;
}
function inferEventType(e) { if (e.tool) return "tool_call"; if (e.patch || e.diff) return "patch"; if (e.verifier || e.test) return "verifier"; if (e.objective) return "objective"; if (e.plan) return "plan"; return "event"; }
function normalizeKnowledgeEvent(e) {
  const kind = ["assumption", "plan", "objective", "architecture"].includes(e.type) ? e.type : e.kind;
  if (!["assumption", "plan", "objective", "architecture"].includes(kind)) return null;
  const text = String(e.text || e.content || e.assumption || e.plan || e.objective || e.statement || "").trim();
  if (!text) return null;
  return { id: e.id || `${kind}_${hash(text).slice(0, 12)}`, kind, text, subject: e.subject || extractSubject(text), polarity: inferPolarity(text), action: inferAction(text), at: e.at || now(), confidence: clamp01(e.confidence ?? 0.55) };
}
function contradictionRelation(a, b) {
  const sim = cosineText(a.subject || a.text, b.subject || b.text);
  if (sim < 0.45 && jaccard(a.text, b.text) < 0.22) return null;
  if (a.polarity && b.polarity && a.polarity === -b.polarity) return { type: a.kind === "architecture" || b.kind === "architecture" ? "architectural-inconsistency" : "conflicting-assumption", severity: 0.55 + 0.4 * sim, explanation: "opposite polarity over overlapping subject" };
  const opposingActions = new Set(["add:remove", "remove:add", "use:avoid", "avoid:use", "enable:disable", "disable:enable", "keep:delete", "delete:keep"]);
  if (a.action && b.action && opposingActions.has(`${a.action}:${b.action}`) && sim > 0.35) return { type: a.kind === "plan" || b.kind === "plan" ? "conflicting-plan" : "conflicting-assumption", severity: 0.5 + 0.35 * sim, explanation: `opposing actions ${a.action}/${b.action}` };
  return null;
}
function inferPolarity(text) { const n = normalize(text); if (/\b(no|not|never|avoid|disable|without|must not|should not|cannot|is not|are not|do not|don't)\b/.test(n)) return -1; if (/\b(use|must|should|is|are|enable|always|requires|required|do)\b/.test(n)) return 1; return 0; }
function inferAction(text) { const n = normalize(text); if (/\b(add|create|introduce|implement)\b/.test(n)) return "add"; if (/\b(remove|delete|drop)\b/.test(n)) return "remove"; if (/\b(use|adopt)\b/.test(n)) return "use"; if (/\b(avoid|forbid|ban)\b/.test(n)) return "avoid"; if (/\b(enable)\b/.test(n)) return "enable"; if (/\b(disable)\b/.test(n)) return "disable"; if (/\b(keep|preserve)\b/.test(n)) return "keep"; return null; }
function extractSubject(text) { return tokens(text).filter((t) => !["use", "avoid", "add", "remove", "must", "should", "not", "never", "always", "implement", "create", "delete"].includes(t)).slice(0, 10).join(" "); }
function eventSignature(e) { return `${e.type}:${e.tool || e.verifier || e.status || ""}:${hash(e.error || e.reason || e.text || e.patchHash || e.plan || e.objective || "").slice(0, 8)}`; }
function repeatedNgrams(xs, k) { const m = new Map(); for (let i = 0; i <= xs.length - k; i++) { const s = xs.slice(i, i + k).join("|"); m.set(s, (m.get(s) || 0) + 1); } return Array.from(m.values()).filter((v) => v > 1).length; }
function repeatedAlternation(xs) { let c = 0; for (let i = 2; i < xs.length; i++) if (xs[i] === xs[i - 2] && xs[i] !== xs[i - 1]) c++; return c; }
function countPatchReversions(patches) { const seen = new Map(); let rev = 0; patches.forEach((p, i) => { const h = p.afterHash || p.contentHash || p.patchHash; if (h && seen.has(h) && i - seen.get(h) > 1) rev++; if (h) seen.set(h, i); if (p.reverted) rev++; }); return rev; }
function computeSemanticDrift(events) {
  const objectives = events.filter((e) => e.type === "objective" || e.objective).map((e) => e.objective || e.text).filter(Boolean);
  const anchor = objectives[objectives.length - 1] || objectives[0] || "";
  if (!anchor) return 0;
  const recent = events.slice(-Math.max(5, Math.ceil(events.length / 4))).map((e) => e.text || e.plan || e.patch || e.error || "").join("\n");
  return clamp01(1 - cosineText(anchor, recent));
}
function computeBranchDivergence(branches) {
  if (branches.length < 2) return 0;
  const ds = [];
  for (let i = 0; i < branches.length; i++) for (let j = i + 1; j < branches.length; j++) {
    const textDistance = 1 - cosineText(branches[i].text, branches[j].text);
    const fileDistance = 1 - jaccard(branches[i].files || new Set(), branches[j].files || new Set());
    ds.push(0.65 * textDistance + 0.35 * fileDistance);
  }
  return clamp01(avg(ds));
}
function computeTokenInefficiency(events, progressEvents) {
  const tokensUsed = sum(events.map((e) => e.tokens || estimateTokens(e.text || e.output || e.error || "")));
  const expectedPerProgress = 1400;
  return clamp01(tokensUsed / Math.max(expectedPerProgress, progressEvents * expectedPerProgress));
}
function computeContextGrowthRate(points) {
  if (points.length < 2) return 0;
  const recent = points.slice(-20); const first = recent[0]; const last = recent[recent.length - 1];
  const dtMinutes = Math.max(1, (last.at - first.at) / 60000); const growth = Math.max(0, last.tokens - first.tokens);
  return clamp01(growth / (dtMinutes * 3000));
}
function contextImportance(b) { return clamp01((b.importance ?? 0.5) * 0.36 + (b.architecturalImportance ?? 0) * 0.24 + (b.verification === "verified" ? 0.22 : b.verification === "contradicted" ? -0.2 : 0.08) + (b.protected ? 0.18 : 0)); }
function stripPrivate(b) { const { _tokens, _score, ...rest } = b; return rest; }
function priority(x) { return x > 0.78 ? "critical" : x > 0.62 ? "high" : x > 0.45 ? "medium" : "low"; }
function healthStatus(m) { return m.entropyScore > 0.86 ? "critical" : m.entropyScore > 0.68 ? "unstable" : m.entropyScore > 0.55 ? "degraded" : m.entropyScore > 0.38 ? "watch" : "stable"; }
function sparkline(values, width = 60) { const ticks = "▁▂▃▄▅▆▇█"; if (!values.length) return ""; const sample = resample(values, width); return sample.map((v) => ticks[Math.max(0, Math.min(ticks.length - 1, Math.round(clamp01(v) * (ticks.length - 1))))]).join(""); }
function heatmap(values, width = 60) { const ticks = " .:-=+*#%@"; if (!values.length) return ""; return resample(values, width).map((v) => ticks[Math.max(0, Math.min(ticks.length - 1, Math.round(clamp01(v) * (ticks.length - 1))))]).join(""); }
function resample(values, width) { if (values.length <= width) return values; const out = []; for (let i = 0; i < width; i++) { const s = Math.floor(i * values.length / width); const e = Math.max(s + 1, Math.floor((i + 1) * values.length / width)); out.push(avg(values.slice(s, e))); } return out; }
function summarizeSnapshots(snapshots) {
  const metrics = snapshots.map((s) => s.metrics || {});
  const keys = ["entropyScore", "stabilityScore", "coherenceScore", "confidenceScore", ...Object.keys(DEFAULT_WEIGHTS)];
  const out = { count: snapshots.length, updatedAt: iso(), means: {}, p95: {}, regressions: 0 };
  for (const k of keys) { const xs = metrics.map((m) => m[k]).filter(Number.isFinite).sort((a, b) => a - b); out.means[k] = avg(xs); out.p95[k] = xs.length ? xs[Math.floor(0.95 * (xs.length - 1))] : 0; }
  for (let i = 1; i < metrics.length; i++) if ((metrics[i].entropyScore || 0) - (metrics[i - 1].entropyScore || 0) > 0.18) out.regressions++;
  return out;
}

module.exports = { DEFAULT_WEIGHTS, DEFAULT_THRESHOLDS, OnlineStats, EntropyMetrics, ContradictionDetector, RecursiveFailureDetector, ContextSanitizer, StabilizationEngine, MetricsPersistence, EntropyDashboard, EntropyMonitor, cosineText, jaccard, estimateTokens, summarizeSnapshots };
