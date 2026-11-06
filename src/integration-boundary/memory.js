"use strict";

const path = require("node:path");
const { CognitiveMemory, MemoryEntry } = require("../cognitive-memory");
const { MemoryJsonStorage, NullSink, noopResult } = require("./common.js");
const { LayeredContextMemory } = require("../layered-context");
const managedStatePermissions = require("../managed-state-permissions");
const { sanitizeManagedState } = require("../managed-state-sanitizer");
const { assertMemoryContentSafe, redactMemoryText, scanMemoryContent } = require("../memory-content-scanner");
const memoryStateCatalog = require("../memory-state-catalog");
const privacyGuardScan = require("../privacy-guard-scan");
const { deriveCorrectionCandidate } = require("../project-memory-candidates");
const { ProjectMemoryDecisionStore } = require("../project-memory-decisions");
const { ProjectMemoryRecall, formatProjectMemoryContext } = require("../project-memory-recall");
const { ProjectMemoryStore } = require("../project-memory-store");
const { SemanticAnchor, SemanticEditEngine, semanticDiff } = require("../semantic-editor");
const sessionStorageAttribution = require("../session-storage-attribution");
const stateInventory = require("../state-inventory");
const stateRetention = require("../state-retention");

class CognitiveMemoryAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), storageKey = "cognitive-memory", sink = new NullSink(), clock, options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.storageKey = storageKey; this.sink = sink;
    let saved = storage.readJson(storageKey, null);
    let hydrationChanged = false;
    if (saved) {
      const sanitized = sanitizeManagedState(saved);
      saved = sanitized.value;
      hydrationChanged = sanitized.changed;
    }
    this.memory = new CognitiveMemory({ clock, ...(options || {}) });
    if (saved) {
      this.memory.lastConsolidatedAt = saved.lastConsolidatedAt || 0;
      this.memory.audit = saved.audit || [];
      // Hydrate trusted persisted entries directly. Re-validating each entry via
      // remember() is O(n^2) because duplicate/contradiction checks scan all
      // existing memories; this made /reload take seconds as local memory grew.
      for (const item of saved.entries || []) {
        const entry = item instanceof MemoryEntry ? item : new MemoryEntry(item, clock);
        if (entry.content !== item.content) hydrationChanged = true;
        this.memory.entries.set(entry.id, entry);
      }
      if (this.enabled && hydrationChanged) this.persist();
    }
  }
  remember(entry) { if (!this.enabled) return noopResult("memory.remember"); const r = this.memory.remember(entry); this.sink.emit({ type: "memory.remember", accepted: r.accepted, id: r.entry?.id }); return r; }
  retrieve(query, options) { if (!this.enabled) return { ...noopResult("memory.retrieve"), entries: [], observations: {} }; return this.memory.retrieve(query, options); }
  findWhere(predicate, limit = Infinity) { if (!this.enabled) return []; const out = []; for (const entry of this.memory.entries.values()) { if (predicate(entry)) out.push(entry); if (out.length >= limit) break; } return out; }
  // Entries are stored oldest-first, so a head-limited scan only ever sees the
  // oldest matches. Candidate detection cares about newly appended memory, so
  // this walks backwards and returns the newest matches in their original order.
  findRecent(predicate, limit = Infinity) {
    if (!this.enabled) return [];
    const values = Array.from(this.memory.entries.values());
    const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : values.length;
    const out = [];
    for (let i = values.length - 1; i >= 0 && out.length < max; i--) if (predicate(values[i])) out.push(values[i]);
    return out.reverse();
  }
  removeWhere(predicate, reason = "removed") { if (!this.enabled) return noopResult("memory.removeWhere"); const removed = []; for (const entry of Array.from(this.memory.entries.values())) if (predicate(entry)) { this.memory.entries.delete(entry.id); removed.push({ id: entry.id, type: entry.type, title: entry.title, reason }); } if (removed.length) this.memory.audit.push({ at: Date.now(), action: "removeWhere", removed }); return { removed }; }
  consolidate(options) { if (!this.enabled) return noopResult("memory.consolidate"); const r = this.memory.consolidate(options); this.sink.emit({ type: "memory.consolidate", decisions: r.decisions?.length || 0, skipped: r.skipped }); return r; }
  metrics() { return this.enabled ? this.memory.metrics() : noopResult("memory.metrics"); }
  persist() { if (!this.enabled) return noopResult("memory.persist"); const data = { version: 1, lastConsolidatedAt: this.memory.lastConsolidatedAt, entries: Array.from(this.memory.entries.values()).map((e) => e.toJSON()), audit: this.memory.audit.slice(-500) }; this.storage.writeJson(this.storageKey, data); return { enabled: true, key: this.storageKey, entries: data.entries.length }; }
}

class StateInventoryAdapter {
  constructor({ enabled = true } = {}) { this.enabled = enabled !== false; }
  inventory(roots, options) { return this.enabled ? stateInventory.inventoryState(roots, options) : { files: [], summary: { complete: false, disabled: true } }; }
  scan(inventory, visitor, options) { return this.enabled ? stateInventory.scanTextInventory(inventory, visitor, options) : { scanned: [], skipped: [], errors: [], summary: { complete: false, disabled: true } }; }
  scanFile(file, visitor, options) { return this.enabled ? stateInventory.scanTextFile(file, visitor, options) : { ok: false, bytesRead: 0, reason: "disabled" }; }
}

class PrivacyGuardScanAdapter {
  constructor({ enabled = true } = {}) { this.enabled = enabled !== false; }
  scan(cwd, roots, options) { return this.enabled ? privacyGuardScan.scan(cwd, roots, options) : { ok: false, scope: {}, roots: [], rootStatus: [], permissionPosture: null, coverage: { complete: false, disabled: true }, summary: { actionable: 0, complete: false }, findings: [], truncated: true, resultTruncated: true }; }
  review(handle) { return this.enabled ? privacyGuardScan.reviewCandidate(handle) : null; }
  patterns() { return this.enabled ? privacyGuardScan.SECRET_PATTERNS : []; }
}

class MemoryStateAdapter {
  constructor({ enabled = true, cwd = process.cwd() } = {}) { this.enabled = enabled !== false; this.cwd = cwd; }
  map(options) { return this.enabled ? memoryStateCatalog.publicMap(this.cwd, options) : noopResult("memoryState.map"); }
  search(query, options) { return this.enabled ? memoryStateCatalog.search(this.cwd, query, options) : { ...noopResult("memoryState.search"), matches: [] }; }
  lineage(id) { return this.enabled ? memoryStateCatalog.lineage(this.cwd, id) : noopResult("memoryState.lineage"); }
  conflicts() { return this.enabled ? memoryStateCatalog.conflicts(this.cwd) : []; }
  curationPlan(options) { return this.enabled ? memoryStateCatalog.curationPlan(this.cwd, options) : noopResult("memoryState.curationPlan"); }
  prunePreview(options) { return this.enabled ? memoryStateCatalog.prunePreview(this.cwd, options) : noopResult("memoryState.prunePreview"); }
  records() { return this.enabled ? memoryStateCatalog.cognitiveEntries(this.cwd) : []; }
}

class RetentionAdapter {
  constructor({ enabled = true, cwd = process.cwd() } = {}) { this.enabled = enabled !== false; this.cwd = cwd; }
  preview(options = {}) { return this.enabled ? stateRetention.previewRetention({ cwd: this.cwd, ...options }) : noopResult("retention.preview"); }
  apply(options = {}) { return this.enabled ? stateRetention.applyRetention({ cwd: this.cwd, ...options }) : noopResult("retention.apply"); }
  rollback(options = {}) { return this.enabled ? stateRetention.rollbackRetention({ cwd: this.cwd, ...options }) : noopResult("retention.rollback"); }
}

class StatePermissionsAdapter {
  constructor({ enabled = true, cwd = process.cwd(), vault, home } = {}) { this.enabled = enabled !== false; this.options = { cwd, vault, home }; }
  preview(options = {}) { return this.enabled ? managedStatePermissions.previewManagedPermissions({ ...this.options, ...options }) : noopResult("statePermissions.preview"); }
  apply(options = {}) { return this.enabled ? managedStatePermissions.applyManagedPermissions({ ...this.options, ...options }) : noopResult("statePermissions.apply"); }
}

class SessionStorageAttributionAdapter {
  constructor({ enabled = true } = {}) { this.enabled = enabled !== false; }
  inspect(options = {}) { return this.enabled ? sessionStorageAttribution.inspectSessionStorage(options) : noopResult("sessionStorage.inspect"); }
  attribute(options = {}) { return this.enabled ? sessionStorageAttribution.attributeSessionStorage(options) : Promise.resolve(noopResult("sessionStorage.attribute")); }
  pressure(snapshot, options = {}) { return this.enabled ? sessionStorageAttribution.sessionStoragePressure(snapshot, options) : noopResult("sessionStorage.pressure"); }
  characterize(report) { return this.enabled ? sessionStorageAttribution.characterizeExternalBlobs(report) : noopResult("sessionStorage.characterize"); }
  archivePreview(options = {}) { return this.enabled ? sessionStorageAttribution.previewSessionArchive(options) : noopResult("sessionStorage.archivePreview"); }
}

class MemoryContentSafetyAdapter {
  constructor({ enabled = true, options = {} } = {}) { this.enabled = enabled !== false; this.options = options; }
  scan(value, options = {}) { return this.enabled ? scanMemoryContent(value, { ...this.options, ...options }) : { schemaVersion: 1, safe: false, reasons: ["scanner-disabled"], blockingReasons: ["scanner-disabled"], findings: [] }; }
  assert(value, options = {}) { if (!this.enabled) { const error = new Error("memory content scanner is disabled"); error.code = "MEMORY_SCANNER_DISABLED"; throw error; } return assertMemoryContentSafe(value, { ...this.options, ...options }); }
  redact(value, options = {}) { return redactMemoryText(value, { ...this.options, ...options }); }
}

class ProjectMemoryAdapter {
  constructor({ enabled = false, cwd = process.cwd(), vault, writeEnabled = false, clock, stateDir, selection = null, readiness = null } = {}) {
    this.enabled = Boolean(enabled && vault);
    this.cwd = cwd;
    this.vault = vault;
    this.selection = selection;
    this.readiness = readiness;
    this.store = this.enabled ? new ProjectMemoryStore({ cwd, vault, writeEnabled, clock, stateDir }) : null;
    this.decisionStore = this.store?.decisions || new ProjectMemoryDecisionStore({ cwd, dir: stateDir || path.join(cwd, ".pi", "project-memory"), clock });
    this.recaller = this.enabled ? new ProjectMemoryRecall({ cwd, store: this.store, stateDir, now: () => { const value = clock ? clock() : Date.now(); return value instanceof Date ? value.getTime() : Number(value); } }) : null;
  }
  metadata() { const selection = this.selection ? Object.fromEntries(Object.entries(this.selection).filter(([key]) => key !== "path")) : null; return { selection, readiness: this.readiness, selectionId: this.selection?.selectionId || null, projectKey: this.selection?.projectKey || null }; }
  status() { return this.enabled ? { ...this.metadata(), ...this.store.status() } : { ...noopResult("projectMemory.status"), ...this.metadata() }; }
  save(input, options) { if (!this.enabled) return noopResult("projectMemory.save"); const result = this.store.upsert(input, options); if (result.applied) this.recaller.compile({ apply: true }); return result; }
  consider(input, options) { if (!this.enabled) return noopResult("projectMemory.consider"); const result = this.store.consider(input, options); if (result.applied) this.recaller.compile({ apply: true }); return result; }
  recall(query, options) { return this.enabled ? { ...this.metadata(), ...this.recaller.recall(query, options) } : { ...noopResult("projectMemory.recall"), items: [], candidates: 0, durationMs: 0, ...this.metadata() }; }
  compile(options) { return this.enabled ? this.recaller.compile(options) : noopResult("projectMemory.compile"); }
  format(result, options) { return this.enabled ? formatProjectMemoryContext(result, options) : ""; }
  standing(options) { return this.enabled ? this.store.standingProjection(options) : { ...noopResult("projectMemory.standing"), items: [], candidates: 0, characters: 0 }; }
  formatStanding(result, { maxChars = 1600 } = {}) { if (!this.enabled || !result?.items?.length) return ""; return ["[L1:standing-project-memory]", ...result.items.map((item) => `- [${item.kind}; ${item.verification}; ${item.id}] ${item.title}: ${item.content}`)].join("\n").slice(0, maxChars); }
  setStanding(input, options) { return this.enabled ? this.store.setStanding(input, options) : noopResult("projectMemory.setStanding"); }
  correction(input, options = {}) { if (!this.enabled) return noopResult("projectMemory.correction"); const derived = deriveCorrectionCandidate(input); if (!derived.ok) return derived; if (options.preview !== false) return { ...derived, outcome: "preview", applied: false }; return { ...derived, result: this.store.consider(derived.candidate, { queueReview: true, apply: options.apply === true, automatic: false }) }; }
  list(options) { return this.enabled ? this.store.list(options) : []; }
  decisions(options) { return this.decisionStore.list(options); }
  provenanceRecords({ limit = 200 } = {}) {
    const entries = this.enabled ? this.store.list({ includeExpired: true, limit }).map((entry) => ({ id: entry.id, candidateHash: entry.candidateHash ? `sha256:${entry.candidateHash.replace(/^sha256:/, "")}` : null, verification: entry.verification, sourceFingerprints: (entry.sourceFingerprints || []).slice(0, 64), evidenceIds: (entry.evidenceIds || []).slice(0, 64), supersedes: (entry.supersedes || []).slice(0, 64), contradicts: (entry.contradicts || []).slice(0, 64), updatedAt: entry.updatedAt })) : [];
    return { entries, decisions: this.decisionStore.list({ limit }) };
  }
}

class LayeredContextAdapter {
  constructor({ enabled = true, storage = new MemoryJsonStorage(), storageKey = "layered-context", sink = new NullSink(), clock, options = {} } = {}) {
    this.enabled = enabled; this.storage = storage; this.storageKey = storageKey; this.sink = sink;
    this.context = new LayeredContextMemory({ clock, ...(options || {}) });
    const saved = storage.readJson(storageKey, null);
    for (const block of saved?.blocks || []) this.context.upsert(block);
  }
  upsert(block) { if (!this.enabled) return noopResult("context.upsert"); const r = this.context.upsert(block); this.sink.emit({ type: "context.upsert", accepted: r.accepted, id: r.block?.id, layer: r.block?.layer }); return r; }
  pack(request) { if (!this.enabled) return { ...noopResult("context.pack"), blocks: [], text: "", observations: { included: [], removed: [] } }; return this.context.pack(request); }
  compactLayer(layer, options) { if (!this.enabled) return noopResult("context.compactLayer"); return this.context.compactLayer(layer, options); }
  remove(id, reason) { if (!this.enabled) return noopResult("context.remove"); return this.context.remove(id, reason); }
  metrics(query) { return this.enabled ? this.context.metrics(query) : noopResult("context.metrics"); }
  persist() { if (!this.enabled) return noopResult("context.persist"); const data = { version: 1, blocks: Array.from(this.context.blocks.values()) }; this.storage.writeJson(this.storageKey, data); return { enabled: true, key: this.storageKey, blocks: data.blocks.length }; }
}

class FileAnchoringAdapter {
  constructor({ enabled = true, sink = new NullSink(), options = {} } = {}) { this.enabled = enabled; this.sink = sink; this.editor = new SemanticEditEngine(options); }
  createAnchor(args) { if (!this.enabled) return noopResult("anchoring.createAnchor"); return SemanticAnchor.fromRegion(args); }
  createPatch(args) { if (!this.enabled) return noopResult("anchoring.createPatch"); return this.editor.createPatch(args); }
  validate(content, patches) { if (!this.enabled) return noopResult("anchoring.validate"); return this.editor.validate(content, patches); }
  diff(before, after, filePath) { if (!this.enabled) return { ...noopResult("anchoring.diff"), hunks: [] }; const r = semanticDiff(before, after, filePath); this.sink.emit({ type: "anchoring.diff", filePath, changed: r.changed }); return r; }
  apply(contentOrPatches, maybePatches, options = {}) { if (!this.enabled) return noopResult("anchoring.apply"); const content = Array.isArray(contentOrPatches) ? "" : contentOrPatches; const patches = Array.isArray(contentOrPatches) ? contentOrPatches : maybePatches; const r = this.editor.apply(content, patches, options); this.sink.emit({ type: "anchoring.apply", ok: r.ok, accepted: r.validation?.resolved?.filter?.((x) => x.resolution?.accepted)?.length || 0 }); return r; }
  rollback(content, checkpoint) { if (!this.enabled) return noopResult("anchoring.rollback"); return this.editor.rollback(content, checkpoint); }
  metrics() { return this.enabled ? this.editor.metrics() : noopResult("anchoring.metrics"); }
}

module.exports = {
  CognitiveMemoryAdapter,
  StateInventoryAdapter,
  PrivacyGuardScanAdapter,
  MemoryStateAdapter,
  RetentionAdapter,
  StatePermissionsAdapter,
  SessionStorageAttributionAdapter,
  MemoryContentSafetyAdapter,
  ProjectMemoryAdapter,
  LayeredContextAdapter,
  FileAnchoringAdapter,
};
