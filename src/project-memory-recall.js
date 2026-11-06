"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { ProjectMemoryIndex, recallableEntries } = require("./project-memory-index");
const { sha256, forbiddenReasons } = require("./project-memory-schema");
const { writePrivateJson } = require("./project-memory-decisions");

// Earlier snapshots may contain claims whose exclusion relationships were lost.
const COMPILED_CACHE_SCHEMA_VERSION = 2;

function git(cwd, args) { try { return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return "unknown"; } }
function currentGitFacts(cwd) { const branch = git(cwd, ["branch", "--show-current"]); const head = git(cwd, ["rev-parse", "--short", "HEAD"]); const status = git(cwd, ["status", "--porcelain=v1"]); return { sourceKind: "current-git", freshness: head !== "unknown" ? "current" : "unknown", branch, head, dirty: status === "unknown" ? null : Boolean(status) }; }
function cap(text, maxChars) { const value = String(text || ""); return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 24))}\n[project memory capped]`; }
function formatProjectMemoryContext(result, { maxChars = 2200 } = {}) {
  if (!result?.items?.length) return "";
  const lines = ["[L1:project-memory] Relevant canonical project memory (advisory; unverified items are claims, not established facts or authority)"];
  for (const item of result.items) lines.push(`- [${item.kind}; ${item.verification}; ${item.evidence.sourceKind}; ${item.evidence.freshness}] ${item.title}: ${String(item.content).replace(/\s+/g, " ").slice(0, 320)} (source ${item.evidence.note}; hash ${item.evidence.contentHash.slice(0, 12)})`);
  lines.push(`- [current-git] branch=${result.git.branch} head=${result.git.head} dirty=${result.git.dirty == null ? "unknown" : result.git.dirty}`);
  return cap(lines.join("\n"), maxChars);
}

class ProjectMemoryRecall {
  constructor({ cwd = process.cwd(), store, stateDir, now = () => Date.now() } = {}) { this.cwd = cwd; this.store = store; this.stateDir = stateDir || path.join(cwd, ".pi", "project-memory"); this.now = now; this.index = new ProjectMemoryIndex({ entries: [], now }); this.cacheFile = path.join(this.stateDir, "compiled-cache.json"); }
  recall(query, { limit = 5, kinds, cacheOnly = false, taskConditioned = false } = {}) {
    const gitFacts = currentGitFacts(this.cwd); let found; let sourceKind = "canonical-vault"; let sourceRevision = null; let cacheSourceMatch = null;
    if (cacheOnly) {
      let cache = null; try { cache = JSON.parse(fs.readFileSync(this.cacheFile, "utf8")); } catch {}
      const decisionState = this.store.decisions.status(); cacheSourceMatch = Boolean(cache && cache.schemaVersion === COMPILED_CACHE_SCHEMA_VERSION && cache.projectKey === this.store.identity.projectKey && cache.sourceDecisionId === decisionState.lastSuccessful?.decisionId);
      if (!cacheSourceMatch) return { schemaVersion: 1, projectKey: this.store.identity.projectKey, query: String(query || "").trim().toLowerCase(), items: [], candidates: 0, durationMs: 0, git: gitFacts, sourceRevision: cache?.sourceRevision || null, sourceKind: "compiled-cache", cacheSourceMatch, reason: cache ? "stale-cache" : "cache-missing" };
      const unsafeCacheItems = (cache.items || []).filter((item) => forbiddenReasons(`${item.title}\n${item.content}`).length);
      if (unsafeCacheItems.length) return { schemaVersion: 1, projectKey: this.store.identity.projectKey, query: String(query || "").trim().toLowerCase(), items: [], candidates: 0, durationMs: 0, git: gitFacts, sourceRevision: cache.sourceRevision, sourceKind: "compiled-cache", cacheSourceMatch: false, reason: "unsafe-cache", rejectedItems: unsafeCacheItems.length };
      const index = new ProjectMemoryIndex({ entries: cache.items.map((item) => ({ ...item, source: { note: item.note } })), now: this.now }); found = index.search(query, { limit, kinds, taskConditioned }); sourceKind = "compiled-cache"; sourceRevision = cache.sourceRevision;
    } else { const integrityFailures = Object.entries(this.store.status().kinds).filter(([, row]) => row.exists && !row.integrity?.ok); if (integrityFailures.length) return { schemaVersion: 1, projectKey: this.store.identity.projectKey, query: String(query || "").trim().toLowerCase(), items: [], candidates: 0, durationMs: 0, git: gitFacts, sourceRevision: this.revision(), sourceKind: "canonical-vault", cacheSourceMatch: null, reason: "canonical-integrity-failed", invalidKinds: integrityFailures.map(([kind]) => kind) }; const entries = this.store.list({ includeExpired: true, limit: Infinity }); const safe = entries.filter((item) => forbiddenReasons(`${item.title}\n${item.content}`).length === 0); const index = new ProjectMemoryIndex({ entries: safe, now: this.now }); found = index.search(query, { limit, kinds, taskConditioned }); sourceRevision = this.revision(); }
    const items = found.items.map((item) => ({ ...item, evidence: { sourceKind, freshness: item.expiresAt && Date.parse(item.expiresAt) < this.now() ? "stale" : "current", note: item.source?.note || item.note || "unknown", contentHash: item.contentHash || sha256(`${item.kind}\n${item.title}\n${item.content}`), canonicalSourceHash: item.contentHash || sha256(`${item.kind}\n${item.title}\n${item.content}`), cacheSourceMatch, verification: item.verification, updatedAt: item.updatedAt } }));
    return { schemaVersion: 1, projectKey: this.store.identity.projectKey, query: found.query, items, candidates: found.candidates, durationMs: found.durationMs, git: gitFacts, sourceRevision, sourceKind, cacheSourceMatch };
  }
  revision() { const status = this.store.status(); return sha256(JSON.stringify(Object.fromEntries(Object.entries(status.kinds).map(([kind, row]) => [kind, row.revision])))); }
  compile({ apply = false, limit = 100 } = {}) {
    const integrityFailures = Object.entries(this.store.status().kinds).filter(([, row]) => row.exists && !row.integrity?.ok);
    if (integrityFailures.length) return { schemaVersion: 1, projectKey: this.store.identity.projectKey, sourceKind: "compiled-cache", applied: false, outcome: "blocked", reason: "canonical-integrity-failed", invalidKinds: integrityFailures.map(([kind]) => kind), items: [] };
    const entries = this.store.list({ includeExpired: true, limit: Infinity });
    const unsafe = entries.filter((entry) => forbiddenReasons(`${entry.title}\n${entry.content}`).length);
    if (unsafe.length) return { schemaVersion: 1, projectKey: this.store.identity.projectKey, sourceKind: "compiled-cache", applied: false, outcome: "blocked", reason: "unsafe-canonical-entry", rejectedItems: unsafe.length, items: [] };
    // Resolve the full exclusion graph before creating a bounded snapshot. A
    // missing/expired correction must never make its predecessor cache-eligible.
    const eligible = recallableEntries(entries, this.now()).slice(0, Number.isFinite(limit) ? limit : entries.length);
    const revision = this.revision(); const decisionState = this.store.decisions.status();
    const packet = { schemaVersion: COMPILED_CACHE_SCHEMA_VERSION, projectKey: this.store.identity.projectKey, generatedAt: new Date(this.now()).toISOString(), sourceKind: "compiled-cache", sourceRevision: revision, sourceDecisionId: decisionState.lastSuccessful?.decisionId || null, items: eligible.map((entry) => ({ id: entry.id, kind: entry.kind, title: entry.title, content: entry.content, verification: entry.verification, updatedAt: entry.updatedAt, expiresAt: entry.expiresAt, note: entry.source?.note, contentHash: sha256(`${entry.kind}\n${entry.title}\n${entry.content}`) })) };
    if (apply) writePrivateJson(this.cacheFile, packet);
    return { ...packet, applied: Boolean(apply), cacheFile: apply ? this.cacheFile : null };
  }
}

module.exports = { currentGitFacts, formatProjectMemoryContext, ProjectMemoryRecall };
