"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { projectIdentity } = require("./project-identity.js");
const { atomicJson } = require("./code-content-cache.js");

const DETAIL_RANK = Object.freeze({ card: 0, outline: 1, body: 2, diagnostics: 1 });
function hash(value) { return crypto.createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex"); }
function ledgerKey(value) { return hash({ projectId: value.projectId, revision: value.revision, configuration: value.configuration || "default", path: value.path, symbolId: value.symbolId, range: value.range }).slice(0, 32); }
function collectRetrievalDetails(value, out = [], entryId = null) {
  if (!value || typeof value !== "object") return out;
  if (Array.isArray(value.items) && value.queryId) for (const item of value.items) if (item?.path || item?.symbolId) out.push({ item, entryId });
  if (Array.isArray(value)) for (const item of value) collectRetrievalDetails(item, out, entryId);
  else for (const [key, item] of Object.entries(value)) if (!["items", "content", "text", "snippet", "extract"].includes(key) && item && typeof item === "object") collectRetrievalDetails(item, out, entryId || value.id);
  return out;
}
class CodeContextLedger {
  constructor(root, options = {}) {
    this.root = path.resolve(root);
    this.project = options.project || projectIdentity(this.root);
    this.projectId = options.projectId || this.project.projectKey;
    this.sessionId = String(options.sessionId || "ephemeral").replace(/[^A-Za-z0-9._-]/g, "_");
    this.stateRoot = path.resolve(options.stateRoot || path.join(this.root, ".pi", "code-context"));
    this.file = path.join(this.stateRoot, "ledgers", `${this.sessionId}.json`);
    this.entries = new Map();
    this.visibleRefs = new Set();
    this.invalidatedPaths = new Set();
    this.load();
  }
  load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (value.projectId !== this.projectId) return;
      for (const entry of value.entries || []) this.entries.set(entry.key, entry);
      for (const file of value.invalidatedPaths || []) this.invalidatedPaths.add(file);
    } catch {}
  }
  persist() {
    atomicJson(this.file, { schemaVersion: 1, projectId: this.projectId, sessionId: this.sessionId, entries: Array.from(this.entries.values()).map(({ visible: _visible, ...entry }) => entry).sort((a, b) => a.key.localeCompare(b.key)), invalidatedPaths: Array.from(this.invalidatedPaths).sort() });
    return this.file;
  }
  record(input = {}) {
    const value = { ...input, projectId: this.projectId, configuration: input.configuration || "default" };
    const key = ledgerKey(value);
    const entry = { key, projectId: this.projectId, revision: value.revision, configuration: value.configuration, path: value.path, range: value.range, symbolId: value.symbolId, detail: value.detail || "card", contentHash: value.contentHash, contentRef: value.contentRef, lastVisibleEntryId: value.visible === false ? null : value.sessionEntryId || null, diagnosticsRevision: value.diagnosticsRevision || null, updatedAt: new Date().toISOString(), stale: false };
    this.entries.set(key, entry);
    if (value.visible !== false && entry.contentRef) this.visibleRefs.add(entry.contentRef);
    if (entry.path) this.invalidatedPaths.delete(entry.path);
    return entry;
  }
  lookup(input = {}) {
    const key = ledgerKey({ ...input, projectId: this.projectId, configuration: input.configuration || "default" });
    const entry = this.entries.get(key);
    if (!entry) return { known: false, visible: false, reusable: false };
    const detailEnough = (DETAIL_RANK[entry.detail] ?? 0) >= (DETAIL_RANK[input.detail || "card"] ?? 0);
    const unchanged = entry.revision === input.revision && entry.configuration === (input.configuration || "default") && entry.contentHash === input.contentHash && !entry.stale && !this.invalidatedPaths.has(entry.path);
    const visible = Boolean(entry.contentRef && this.visibleRefs.has(entry.contentRef));
    return { known: true, visible, reusable: detailEnough && unchanged && visible, detailEnough, unchanged, entry, contentRef: detailEnough && unchanged && visible ? entry.contentRef : null };
  }
  invalidate(paths) {
    const touched = new Set((paths || []).map((file) => String(file).replace(/\\/g, "/")));
    for (const file of touched) this.invalidatedPaths.add(file);
    for (const entry of this.entries.values()) if (touched.has(entry.path)) { entry.stale = true; if (entry.contentRef) this.visibleRefs.delete(entry.contentRef); }
    return { invalidated: Array.from(touched).sort() };
  }
  clearVisibility() { this.visibleRefs.clear(); for (const entry of this.entries.values()) entry.lastVisibleEntryId = null; }
  reconstruct(activeEntries = []) {
    this.clearVisibility();
    const found = [];
    for (const entry of activeEntries || []) {
      const entryId = entry?.id || entry?.entryId || null;
      const details = entry?.details || entry?.message?.details || entry?.message?.toolResult?.details || entry?.toolResult?.details;
      for (const row of collectRetrievalDetails(details, [], entryId)) {
        const item = row.item;
        if (!item.contentRef) continue;
        this.visibleRefs.add(item.contentRef);
        found.push(item.contentRef);
        for (const known of this.entries.values()) if (known.contentRef === item.contentRef) known.lastVisibleEntryId = row.entryId;
      }
    }
    return { visibleRefs: Array.from(new Set(found)).sort(), entriesScanned: activeEntries.length };
  }
  compact(activeEntries) { return this.reconstruct(activeEntries); }
  protectedRefs() { return Array.from(new Set(Array.from(this.entries.values()).filter((entry) => !entry.stale).map((entry) => entry.contentRef).filter(Boolean))).sort(); }
  summary() { return { projectId: this.projectId, sessionId: this.sessionId, entries: this.entries.size, visible: this.visibleRefs.size, stale: Array.from(this.entries.values()).filter((entry) => entry.stale).length, invalidatedPaths: Array.from(this.invalidatedPaths).sort() }; }
}

module.exports = { DETAIL_RANK, ledgerKey, collectRetrievalDetails, CodeContextLedger };
