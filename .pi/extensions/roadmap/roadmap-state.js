"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { FileIntegrationStorage } = require("../../../src/file-integration-storage.js");
const { EvidenceStore } = require("../../../src/evidence-binder.js");

const ROADMAP_VERSION = 3;
const MUTATION_ENVELOPE_VERSION = 1;
const ROADMAP_STATUSES = Object.freeze(["pending", "active", "done", "verified", "verified-unsubstantiated", "blocked", "paused", "shelved", "skipped", "archived"]);
const ROADMAP_LIFECYCLE_STATUSES = Object.freeze(["active", "closed", "shelved", "archived"]);
const COMPLETE_STATUSES = new Set(["done", "verified"]);
const FINAL_STATUSES = new Set(["done", "verified", "verified-unsubstantiated", "skipped", "archived"]);
const NONACTIONABLE_STATUSES = new Set(["blocked", "paused", "shelved"]);
const ROADMAP_ERROR_CODES = Object.freeze({
  STALE_ITEM: "ROADMAP_STALE_ITEM",
  INVALID_OPERATION: "ROADMAP_INVALID_OPERATION",
  MISSING_PARENT: "ROADMAP_MISSING_PARENT",
  PARENT_REQUIRED: "ROADMAP_PARENT_REQUIRED",
  EVIDENCE_REQUIRED: "ROADMAP_EVIDENCE_REQUIRED",
  INVALID_EVIDENCE: "ROADMAP_INVALID_EVIDENCE",
  STALE_EVIDENCE: "ROADMAP_STALE_EVIDENCE",
  LIFECYCLE_CONFLICT: "ROADMAP_LIFECYCLE_CONFLICT",
  PERSISTENCE_FAILED: "ROADMAP_PERSISTENCE_FAILED",
});

class RoadmapError extends Error {
  constructor(code, message) { super(message); this.name = "RoadmapError"; this.code = code; }
}
function roadmapError(code, message) { return new RoadmapError(code, message); }

function nowIso() { return new Date().toISOString(); }
function shortId(prefix = "roadmap") { return `${prefix}_${crypto.randomBytes(6).toString("hex")}`; }
const SESSION_STORE_DIR = "sessions";
const projectRootCache = new Map();
// Roadmaps are bound to the session that owns them, so concurrent sessions in
// one directory keep independent plans instead of overwriting each other.
// Unscoped callers (scripts, topology appliers outside a session) stay on the
// directory-level store.
let activeSessionScope = null;

// The store belongs to the worktree (or project root) that owns the cwd, so a
// nested working directory shares its repository's roadmap while separate Git
// worktrees keep independent roadmaps.
function resolveProjectRoot(cwd) {
  const resolved = path.resolve(cwd || process.cwd());
  const cached = projectRootCache.get(resolved);
  if (cached) return cached;
  let root = resolved;
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: resolved, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 5000 }).trim();
    if (topLevel) root = path.resolve(topLevel);
  } catch {}
  projectRootCache.set(resolved, root);
  return root;
}
function normalizeSessionId(value) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  if (/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(text)) return text;
  // An id that cannot be a directory name still owns a private store; dropping
  // the scope would silently share another session's roadmap.
  return `session-${crypto.createHash("sha256").update(text).digest("hex").slice(0, 16)}`;
}
function setRoadmapSessionScope(sessionId) { activeSessionScope = normalizeSessionId(sessionId); return activeSessionScope; }
function roadmapSessionScope(options = {}) { return options && "sessionId" in options ? normalizeSessionId(options.sessionId) : activeSessionScope; }
function roadmapRoot(cwd) { return path.join(resolveProjectRoot(cwd), ".pi", "roadmap"); }
function roadmapDir(cwd, options = {}) {
  const root = roadmapRoot(cwd);
  const sessionId = roadmapSessionScope(options);
  return sessionId ? path.join(root, SESSION_STORE_DIR, sessionId) : root;
}
function roadmapStorage(cwd, options = {}) { return new FileIntegrationStorage(roadmapDir(cwd, options)); }
function stateFile(cwd, options = {}) { return path.join(roadmapDir(cwd, options), "active.json"); }
function lastKnownGoodFile(cwd, options = {}) { return path.join(roadmapDir(cwd, options), "last-known-good.json"); }
function archiveIndexFile(cwd, options = {}) { return path.join(roadmapDir(cwd, options), "archive-index.jsonl"); }
function reasoningStateFile(cwd) { return path.join(cwd || process.cwd(), ".pi", "cognitive-automation", "reasoning-runtime.json"); }
function cleanText(value, fallback = "") {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return text || fallback;
}
function validStatus(status) { return ROADMAP_STATUSES.includes(status); }
function statusOrPending(status) { return validStatus(status) ? status : "pending"; }
function lifecycleOrActive(status) { return ROADMAP_LIFECYCLE_STATUSES.includes(status) ? status : "active"; }
function hashPacket(value) { return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function itemContentShape(item) {
  return {
    id: cleanText(item?.id),
    title: cleanText(item?.title),
    source: cleanText(item?.source),
    sourceArtifactId: item?.sourceArtifactId || null,
    sourceStepId: item?.sourceStepId || null,
    subtasks: (item?.subtasks || []).map((subtask) => ({ id: cleanText(subtask?.id), title: cleanText(subtask?.title), items: (subtask?.items || []).map(itemContentShape) })),
  };
}
function itemContentFingerprint(item) { return `roadmap_item_${hashPacket(itemContentShape(item)).slice(0, 24)}`; }
function normalizeTransition(input = {}) {
  const provenance = ["manual", "work-backed", "batch", "backfill", "override", "migration"].includes(input.provenance) ? input.provenance : "manual";
  return {
    at: input.at || nowIso(),
    from: validStatus(input.from) ? input.from : "pending",
    to: validStatus(input.to) ? input.to : "pending",
    provenance,
    evidenceBound: input.evidenceBound === true,
  };
}
function stamp(state, nested) {
  const updatedAt = nowIso();
  if (nested && nested !== state) nested.updatedAt = updatedAt;
  state.updatedAt = updatedAt;
  return state;
}
function pathId(prefix, segments) { return `${prefix}-${segments.join("-")}`; }
function nextItemId(items = [], roadmapPath = []) {
  let ordinal = items.length + 1;
  let id = pathId("item", [...roadmapPath, ordinal]);
  const used = new Set(items.map((item) => item.id));
  while (used.has(id)) id = pathId("item", [...roadmapPath, ++ordinal]);
  return id;
}

function normalizeItem(input, index = 0, options = {}) {
  const raw = typeof input === "string" ? { title: input } : (input || {});
  const itemPath = [...(options.path || []), index + 1];
  const title = cleanText(raw.title || raw.text || raw.description, `Step ${index + 1}`);
  const rawSubtasks = Array.isArray(raw.subtasks)
    ? raw.subtasks
    : Array.isArray(raw.subroadmaps)
      ? raw.subroadmaps
      : raw.subroadmap ? [raw.subroadmap] : [];
  const originalStatus = statusOrPending(raw.status);
  const status = options.legacyVersion < ROADMAP_VERSION && originalStatus === "verified" && !Array.isArray(raw.evidenceBindings)
    ? "verified-unsubstantiated"
    : originalStatus;
  const item = {
    id: (options.regenerateIds ? pathId("item", itemPath) : cleanText(raw.id, pathId("item", itemPath))).replace(/\s+/g, "-"),
    title,
    status,
    source: raw.source || "manual",
    sourceArtifactId: raw.sourceArtifactId || raw.artifactId || undefined,
    sourceStepId: raw.sourceStepId || undefined,
    artifactIds: Array.isArray(raw.artifactIds)
      ? [...new Set(raw.artifactIds.map(String).filter(Boolean))]
      : raw.artifactId ? [String(raw.artifactId)] : [],
    evidenceIds: Array.isArray(raw.evidenceIds)
      ? [...new Set(raw.evidenceIds.map(String).filter(Boolean))]
      : raw.evidenceId ? [String(raw.evidenceId)] : [],
    evidenceBindings: Array.isArray(raw.evidenceBindings) ? raw.evidenceBindings.slice(-20).flatMap((binding) => {
      if (!binding?.evidenceId || !binding?.itemFingerprint) return [];
      return [{ evidenceId: String(binding.evidenceId), evidenceFingerprint: binding.evidenceFingerprint ? String(binding.evidenceFingerprint) : null, itemFingerprint: String(binding.itemFingerprint), linkedAt: binding.linkedAt || nowIso(), provenance: ["work-backed", "batch", "backfill", "manual"].includes(binding.provenance) ? binding.provenance : "manual", validated: binding.validated === true }];
    }) : [],
    notes: Array.isArray(raw.notes) ? raw.notes.map(String).filter(Boolean).slice(-20) : [],
    transitions: Array.isArray(raw.transitions) ? raw.transitions.slice(-20).map(normalizeTransition) : [],
    subtasks: rawSubtasks
      .map((subtask, subtaskIndex) => normalizeRoadmap(subtask, {
        path: [...itemPath, subtaskIndex + 1],
        regenerateIds: options.regenerateIds,
        legacyVersion: options.legacyVersion,
      }))
      .filter(Boolean),
  };
  const hasValidatedCurrentBinding = item.evidenceBindings.some((binding) => binding.validated === true && binding.itemFingerprint === itemContentFingerprint(item));
  if (item.status === "verified" && !hasValidatedCurrentBinding) item.status = "verified-unsubstantiated";
  if (item.status === "verified-unsubstantiated" && originalStatus === "verified" && !item.transitions.some((transition) => transition.provenance === "migration")) {
    item.transitions.push(normalizeTransition({ from: "verified", to: "verified-unsubstantiated", provenance: "migration" }));
  }
  return item;
}

function normalizeRoadmap(input, options = {}) {
  if (!input || typeof input !== "object") return null;
  const roadmapPath = options.path || [];
  const legacyVersion = Number(options.legacyVersion || input.version || 1);
  const items = Array.isArray(input.items)
    ? input.items.map((item, index) => normalizeItem(item, index, { path: roadmapPath, regenerateIds: options.regenerateIds, legacyVersion }))
    : [];
  const state = {
    version: ROADMAP_VERSION,
    id: options.regenerateIds && roadmapPath.length ? pathId("roadmap", roadmapPath) : (input.id || shortId("roadmap")),
    title: cleanText(input.title, "Roadmap"),
    scope: input.scope === "session" ? "session" : "project",
    source: input.source || "manual",
    sourceArtifactId: input.sourceArtifactId || undefined,
    createdAt: input.createdAt || nowIso(),
    updatedAt: input.updatedAt || input.createdAt || nowIso(),
    lifecycle: {
      status: lifecycleOrActive(input.lifecycle?.status),
      changedAt: input.lifecycle?.changedAt || input.updatedAt || input.createdAt || nowIso(),
      reason: input.lifecycle?.reason ? cleanText(input.lifecycle.reason) : undefined,
    },
    activeItemId: options.regenerateIds ? undefined : (input.activeItemId || undefined),
    adoptedFrom: input.adoptedFrom?.roadmapId ? { sessionId: cleanText(input.adoptedFrom.sessionId) || null, roadmapId: cleanText(input.adoptedFrom.roadmapId), adoptedAt: input.adoptedFrom.adoptedAt || undefined } : undefined,
    items,
  };
  ensureActiveItem(state);
  return state;
}

function createRoadmap(title, items = [], options = {}) {
  const state = normalizeRoadmap({
    id: options.id || shortId("roadmap"),
    title: cleanText(title, "Roadmap"),
    scope: options.scope || "project",
    source: options.source || "manual",
    sourceArtifactId: options.sourceArtifactId,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    items,
  }, { path: options.path || [], regenerateIds: options.regenerateIds });
  ensureActiveItem(state);
  return state;
}

function normalizeMilestones(milestones = []) {
  if (!Array.isArray(milestones) || milestones.length === 0) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "An executable plan requires at least one milestone.");
  if (milestones.length > 20) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "An executable plan may contain at most 20 milestones.");
  return milestones.map((input, index) => {
    const milestone = typeof input === "string" ? { title: input, goals: [] } : (input || {});
    const title = cleanText(milestone.title || milestone.name);
    if (!title) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Milestone ${index + 1} requires a non-blank title.`);
    const goals = Array.isArray(milestone.goals) ? milestone.goals.map((goal) => cleanText(typeof goal === "string" ? goal : goal?.title || goal?.description)) : [];
    if (goals.length === 0) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Milestone ${index + 1} requires at least one goal.`);
    if (goals.some((goal) => !goal)) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Milestone ${index + 1} goals must not be blank.`);
    if (goals.length > 20) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Milestone ${index + 1} may contain at most 20 goals.`);
    return { title, goals };
  });
}

function createPlanRoadmap(title, milestones = [], options = {}) {
  const source = options.source || "manual-plan";
  const items = normalizeMilestones(milestones).map((milestone) => ({
    title: milestone.title,
    source,
    subtasks: [{
      title: `${milestone.title} goals`,
      source,
      items: milestone.goals.map((goal) => ({ title: goal, source })),
    }],
  }));
  return createRoadmap(title, items, { ...options, source });
}

function archiveReasonCategory(reason) {
  const value = cleanText(reason, "archived");
  return ["root-replaced", "cleared", "completed-on-next-input", "manual-archive", "tool-archive", "tool-clear", "archived"].includes(value) ? value : "other";
}
function archiveRoadmapPacket(cwd, state, reason = "replaced", options = {}) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return null;
  const storage = roadmapStorage(cwd, options);
  const progress = getProgress(normalized);
  const safeId = String(normalized.id).replace(/[^A-Za-z0-9_.-]/g, "_");
  storage.writeJson(`archive/${safeId}`, { ...normalized, lifecycle: { status: "archived", changedAt: nowIso(), reason: cleanText(reason, "archived") } });
  const row = { schemaVersion: 1, roadmapId: safeId, archivedAt: nowIso(), reasonCategory: archiveReasonCategory(reason), itemCount: progress.total, completeCount: progress.complete, unresolvedCount: progress.unresolved };
  const rows = [...storage.readJsonl("archive-index"), row].slice(-500);
  storage.writeJsonl("archive-index", rows);
  return row;
}

function evidenceValidatorForCwd(cwd) {
  const store = new EvidenceStore({ cwd });
  return (evidenceId) => store.validateEvidenceId(evidenceId, { requireOk: true });
}
function revalidateEvidenceBindings(state, validateEvidenceId) {
  const next = normalizeRoadmap(state);
  if (!next) return null;
  const validate = typeof validateEvidenceId === "function" ? validateEvidenceId : () => ({ ok: false, reason: "evidence-validator-missing" });
  for (const { item } of flattenItems(next)) {
    for (const binding of item.evidenceBindings || []) {
      let result = null;
      try { result = validate(binding.evidenceId); } catch {}
      const packetFingerprint = result?.evidence?.fingerprint ? String(result.evidence.fingerprint) : null;
      binding.validated = result?.ok === true && Boolean(binding.evidenceFingerprint) && binding.evidenceFingerprint === packetFingerprint;
    }
    if (item.status === "verified" && !hasCurrentEvidence(item)) {
      item.status = "verified-unsubstantiated";
      item.transitions = [...(item.transitions || []), normalizeTransition({ from: "verified", to: "verified-unsubstantiated", provenance: "migration" })].slice(-20);
    }
  }
  refreshActiveHierarchy(next);
  return next;
}
function loadRoadmap(cwd, options = {}) {
  const file = stateFile(cwd, options);
  if (!fs.existsSync(file)) return null;
  try {
    const storage = roadmapStorage(cwd, options);
    const active = storage.readJson("active", null);
    if (active) return revalidateEvidenceBindings(active, evidenceValidatorForCwd(cwd));
    const fallback = storage.readJson("last-known-good", null);
    if (fallback) {
      const recovered = revalidateEvidenceBindings(fallback, evidenceValidatorForCwd(cwd));
      recovered.recoveredFromLastKnownGood = true;
      return recovered;
    }
    throw new Error("no valid state packet");
  } catch { throw roadmapError(ROADMAP_ERROR_CODES.PERSISTENCE_FAILED, "Roadmap state could not be read or recovered."); }
}

function saveRoadmap(cwd, state, options = {}) {
  const normalized = revalidateEvidenceBindings(state, evidenceValidatorForCwd(cwd));
  if (!normalized) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "Cannot save empty roadmap state");
  try {
    const storage = roadmapStorage(cwd, options);
    const existing = storage.readJson("active", null);
    if (existing) {
      const current = normalizeRoadmap(existing);
      storage.writeJson("last-known-good", current);
      if (current.id !== normalized.id) archiveRoadmapPacket(cwd, current, "root-replaced", options);
    }
    storage.writeJson("active", normalized);
    storage.copyJson("active", "last-known-good");
    return normalized;
  } catch { throw roadmapError(ROADMAP_ERROR_CODES.PERSISTENCE_FAILED, "Roadmap state could not be saved atomically."); }
}

function clearRoadmap(cwd, options = {}) {
  try {
    const storage = roadmapStorage(cwd, options);
    const existing = storage.readJson("active", null);
    if (existing && options.archive !== false) archiveRoadmapPacket(cwd, existing, options.reason || "cleared", options);
    storage.deleteJson("active");
  } catch { throw roadmapError(ROADMAP_ERROR_CODES.PERSISTENCE_FAILED, "Roadmap state could not be cleared."); }
  return null;
}

// Several sessions can keep roadmaps in one directory. Listing them lets a
// session explicitly adopt earlier work instead of silently overwriting it.
// Per-turn discovery is bounded to the most recently touched stores.
function roadmapSessionStores(cwd, limit = 25) {
  const dir = path.join(roadmapRoot(cwd), SESSION_STORE_DIR);
  let names = [];
  try { names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  const stores = names.flatMap((sessionId) => {
    const store = path.join(dir, sessionId);
    try { return [{ sessionId, store, mtime: fs.statSync(path.join(store, "active.json")).mtimeMs }]; } catch { return []; }
  }).sort((left, right) => right.mtime - left.mtime);
  return limit > 0 ? stores.slice(0, limit) : stores;
}
function roadmapStoreCandidates(cwd, options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(0, Math.floor(options.limit)) : 25;
  const candidates = [];
  const collect = (store, sessionId) => {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(path.join(store, "active.json"), "utf8")); } catch { return; }
    const roadmap = normalizeRoadmap(raw);
    if (!roadmap) return;
    const progress = progressForNormalized(roadmap);
    candidates.push({
      roadmapId: roadmap.id,
      title: cleanText(roadmap.title, "Roadmap"),
      sessionId: sessionId || null,
      store,
      lifecycle: progress.lifecycle,
      outcomes: progress.outcomes,
      complete: progress.complete,
      total: progress.total,
      actionable: progress.actionable,
      settled: isRoadmapSettledNormalized(roadmap),
      updatedAt: roadmap.updatedAt || null,
    });
  };
  collect(roadmapRoot(cwd), null);
  for (const entry of roadmapSessionStores(cwd, limit)) collect(entry.store, entry.sessionId);
  const seen = new Set();
  return candidates
    .filter((candidate) => candidate.lifecycle !== "archived")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")))
    .filter((candidate) => (seen.has(candidate.roadmapId) ? false : (seen.add(candidate.roadmapId), true)));
}

function ownRoadmapId(cwd, options = {}) {
  try {
    return cleanText(JSON.parse(fs.readFileSync(path.join(roadmapDir(cwd, options), "active.json"), "utf8"))?.id) || null;
  } catch { return null; }
}

// Adoption copies the packet into the current session's store; the source
// roadmap stays untouched for the session that owns it. The lookup spans every
// session store in the directory, not just the discovery window.
function adoptRoadmap(cwd, roadmapId, options = {}) {
  const ref = cleanText(roadmapId);
  if (!ref) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "Adopting a roadmap requires a roadmapId reported by roadmapStoreCandidates.");
  const scope = roadmapSessionScope(options);
  const own = ownRoadmapId(cwd, options);
  if (own === ref) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Roadmap ${ref} is already bound to this session.`);
  const candidate = roadmapStoreCandidates(cwd, { limit: 0 }).find((entry) => entry.roadmapId === ref && entry.sessionId !== scope);
  if (!candidate) throw roadmapError(ROADMAP_ERROR_CODES.STALE_ITEM, `Roadmap is not available in this directory: ${ref}`);
  // Adoption must not silently discard a roadmap the session is already working on.
  if (own) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `This session already has roadmap ${own}; close, shelve, or clear it before adopting another.`);
  let raw;
  try { raw = JSON.parse(fs.readFileSync(path.join(candidate.store, "active.json"), "utf8")); }
  catch { throw roadmapError(ROADMAP_ERROR_CODES.PERSISTENCE_FAILED, "Roadmap state could not be read or recovered."); }
  const roadmap = normalizeRoadmap(raw);
  roadmap.adoptedFrom = { sessionId: candidate.sessionId, roadmapId: candidate.roadmapId, adoptedAt: nowIso() };
  roadmap.updatedAt = nowIso();
  return saveRoadmap(cwd, roadmap, options);
}

function isRoadmapActionableNormalized(roadmap) {
  if (!roadmap || roadmap.lifecycle?.status !== "active") return false;
  return roadmap.items.some((item) => isItemActionable(item));
}
function isItemActionable(item) {
  if (!item || FINAL_STATUSES.has(item.status) || NONACTIONABLE_STATUSES.has(item.status)) return false;
  const unresolvedSubtasks = (item.subtasks || []).filter((subtask) => !isRoadmapSettledNormalized(subtask));
  if (!unresolvedSubtasks.length) return ["pending", "active"].includes(item.status);
  return unresolvedSubtasks.some(isRoadmapActionableNormalized);
}
function ensureActiveItem(roadmap) {
  if (!roadmap) return roadmap;
  if (roadmap.lifecycle?.status !== "active") {
    for (const item of roadmap.items) if (item.status === "active") item.status = "pending";
    roadmap.activeItemId = undefined;
    return roadmap;
  }
  let active = roadmap.activeItemId ? roadmap.items.find((item) => item.id === roadmap.activeItemId && isItemActionable(item)) : null;
  if (!active) active = roadmap.items.find((item) => item.status === "active" && isItemActionable(item)) || null;
  if (!active) active = roadmap.items.find((item) => item.status === "pending" && isItemActionable(item)) || null;
  for (const item of roadmap.items) if (item !== active && item.status === "active") item.status = "pending";
  if (active) {
    active.status = "active";
    roadmap.activeItemId = active.id;
  } else roadmap.activeItemId = undefined;
  return roadmap;
}

function samePath(left, right) {
  return left.length === right.length && left.every((part, index) => part === right[index]);
}
function parseNumericPath(ref, prefix) {
  const token = String(ref || "").replace(prefix, "").trim();
  if (!/^\d+(?:\.\d+)*$/.test(token)) return null;
  return token.split(".").map(Number);
}
function locateItem(roadmap, ref, roadmapPath = [], ancestors = []) {
  const token = String(ref || "").replace(/^#/, "").trim();
  if (!roadmap || !token) return null;
  const numericPath = parseNumericPath(token, /^#/);
  for (let index = 0; index < roadmap.items.length; index++) {
    const item = roadmap.items[index];
    const itemPath = [...roadmapPath, index + 1];
    if ((numericPath && samePath(itemPath, numericPath)) || (!numericPath && item.id === token)) {
      return { item, roadmap, path: itemPath, roadmapPath, ancestors };
    }
    for (let subtaskIndex = 0; subtaskIndex < item.subtasks.length; subtaskIndex++) {
      const subtask = item.subtasks[subtaskIndex];
      const found = locateItem(subtask, token, [...itemPath, subtaskIndex + 1], [...ancestors, { item, roadmap, path: itemPath }]);
      if (found) return found;
    }
  }
  return null;
}
function locateRoadmap(roadmap, ref, roadmapPath = [], parentItem = null) {
  const token = String(ref || "").replace(/^@/, "").trim();
  if (!roadmap) return null;
  const numericPath = token ? parseNumericPath(token, /^@/) : null;
  if (!token || roadmap.id === token || (numericPath && samePath(roadmapPath, numericPath))) {
    return { roadmap, path: roadmapPath, parentItem };
  }
  for (let itemIndex = 0; itemIndex < roadmap.items.length; itemIndex++) {
    const item = roadmap.items[itemIndex];
    const itemPath = [...roadmapPath, itemIndex + 1];
    for (let subtaskIndex = 0; subtaskIndex < item.subtasks.length; subtaskIndex++) {
      const found = locateRoadmap(item.subtasks[subtaskIndex], token, [...itemPath, subtaskIndex + 1], item);
      if (found) return found;
    }
  }
  return null;
}
function findItem(state, ref) {
  const normalized = normalizeRoadmap(state);
  return locateItem(normalized, ref)?.item || null;
}
function flattenItems(roadmap, roadmapPath = [], output = []) {
  for (let itemIndex = 0; itemIndex < roadmap.items.length; itemIndex++) {
    const item = roadmap.items[itemIndex];
    const itemPath = [...roadmapPath, itemIndex + 1];
    output.push({ item, roadmap, path: itemPath, roadmapPath });
    for (let subtaskIndex = 0; subtaskIndex < item.subtasks.length; subtaskIndex++) {
      flattenItems(item.subtasks[subtaskIndex], [...itemPath, subtaskIndex + 1], output);
    }
  }
  return output;
}
function isRoadmapSettledNormalized(roadmap) {
  return roadmap.items.length > 0 && roadmap.items.every((item) =>
    FINAL_STATUSES.has(item.status) && item.subtasks.every(isRoadmapSettledNormalized));
}
function isRoadmapSettled(state) {
  const normalized = normalizeRoadmap(state);
  return Boolean(normalized && isRoadmapSettledNormalized(normalized));
}
function localActiveItem(roadmap) {
  if (roadmap?.lifecycle?.status !== "active") return null;
  return roadmap.items.find((item) => item.id === roadmap.activeItemId && isItemActionable(item))
    || roadmap.items.find((item) => item.status === "active" && isItemActionable(item))
    || null;
}
function activeContext(roadmap) {
  let currentRoadmap = roadmap;
  let roadmapPath = [];
  const activePath = [];
  while (currentRoadmap) {
    const item = localActiveItem(currentRoadmap);
    if (!item) return { roadmap: currentRoadmap, roadmapPath, item: activePath.at(-1)?.item || null, activePath };
    const itemIndex = currentRoadmap.items.indexOf(item);
    const itemPath = [...roadmapPath, itemIndex + 1];
    activePath.push({ item, roadmap: currentRoadmap, path: itemPath, roadmapPath });
    let nextSubtaskIndex = -1;
    for (let index = item.subtasks.length - 1; index >= 0; index--) {
      if (!isRoadmapSettledNormalized(item.subtasks[index]) && isRoadmapActionableNormalized(item.subtasks[index])) {
        nextSubtaskIndex = index;
        break;
      }
    }
    if (nextSubtaskIndex < 0) return { roadmap: currentRoadmap, roadmapPath, item, activePath };
    currentRoadmap = item.subtasks[nextSubtaskIndex];
    roadmapPath = [...itemPath, nextSubtaskIndex + 1];
  }
  return { roadmap, roadmapPath: [], item: null, activePath };
}
function getActivePath(state) {
  const normalized = normalizeRoadmap(state);
  return normalized ? activeContext(normalized).activePath : [];
}
function activateItem(roadmap, item) {
  for (const other of roadmap.items) if (other !== item && other.status === "active") other.status = "pending";
  item.status = "active";
  roadmap.activeItemId = item.id;
}
function activateLocation(location) {
  for (const ancestor of location.ancestors) activateItem(ancestor.roadmap, ancestor.item);
  activateItem(location.roadmap, location.item);
}

function addItem(state, title, options = {}) {
  const next = normalizeRoadmap(state) || createRoadmap(options.roadmapTitle || "Roadmap");
  const context = activeContext(next);
  const target = options.roadmapId
    ? locateRoadmap(next, options.roadmapId)
    : options.activeRoadmap && context.activePath.length ? { roadmap: context.roadmap, path: context.roadmapPath } : options.activeRoadmap ? null : { roadmap: next, path: [] };
  if (!target) throw roadmapError(options.roadmapId ? ROADMAP_ERROR_CODES.MISSING_PARENT : ROADMAP_ERROR_CODES.PARENT_REQUIRED, options.roadmapId ? `Roadmap parent not found: ${options.roadmapId}` : "No actionable roadmap scope is active; select a roadmap explicitly or resume it before adding work.");
  if (target.roadmap.lifecycle?.status !== "active") throw roadmapError(ROADMAP_ERROR_CODES.LIFECYCLE_CONFLICT, "Cannot add work to a closed, shelved, or archived roadmap; resume it first.");
  const item = normalizeItem({ ...options, id: options.id || nextItemId(target.roadmap.items, target.path), title, status: options.status || "pending" }, target.roadmap.items.length, { path: target.path });
  for (const evidenceId of options.evidenceIds || (options.evidenceId ? [options.evidenceId] : [])) addEvidenceBinding(item, evidenceId, { ...options, provenance: options.provenance || "manual" });
  target.roadmap.items.push(item);
  if (!target.roadmap.activeItemId) ensureActiveItem(target.roadmap);
  return stamp(next, target.roadmap);
}

function addItems(state, titles, options = {}) {
  const list = (Array.isArray(titles) ? titles : [titles])
    .map((entry) => cleanText(typeof entry === "string" ? entry : entry?.title))
    .filter(Boolean);
  if (!list.length) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "Adding roadmap items requires at least one title.");
  let next = state;
  for (const title of list) next = addItem(next, title, options);
  return next;
}

function addSubtaskRoadmap(state, title, items = [], options = {}) {
  const next = normalizeRoadmap(state);
  if (!next) throw roadmapError(ROADMAP_ERROR_CODES.MISSING_PARENT, "No roadmap active. Start a root roadmap before adding a subtask roadmap.");
  let parent = null;
  if (options.parentId) {
    parent = locateItem(next, options.parentId);
    if (!parent) throw roadmapError(ROADMAP_ERROR_CODES.MISSING_PARENT, `Roadmap parent item not found: ${options.parentId}`);
  } else {
    const context = activeContext(next);
    const leaf = context.activePath.at(-1);
    parent = leaf ? locateItem(next, leaf.item.id) : null;
  }
  if (!parent) throw roadmapError(ROADMAP_ERROR_CODES.PARENT_REQUIRED, "No actionable roadmap item is available to own this subtask roadmap; provide parentId after resuming or selecting valid scope.");
  if (parent.roadmap.lifecycle?.status !== "active" || !isItemActionable(parent.item)) throw roadmapError(ROADMAP_ERROR_CODES.PARENT_REQUIRED, `Roadmap parent is not actionable: ${options.parentId || parent.item.id}`);
  if (parent.item.status !== "active") activateLocation(parent);
  const subtaskPath = [...parent.path, parent.item.subtasks.length + 1];
  const subtaskOptions = {
    source: options.source || "manual",
    sourceArtifactId: options.sourceArtifactId,
    scope: next.scope,
    path: subtaskPath,
    regenerateIds: true,
  };
  const subtask = options.milestones
    ? createPlanRoadmap(title, options.milestones, subtaskOptions)
    : createRoadmap(title, items, subtaskOptions);
  parent.item.subtasks.push(subtask);
  return stamp(next, subtask);
}

function startRoadmap(state, title, items = [], options = {}) {
  const current = normalizeRoadmap(state);
  if (!options.replace && !options.sourceArtifactId && current && cleanText(title) === current.title) {
    const requested = options.milestones ? normalizeMilestones(options.milestones) : items.map((item) => cleanText(typeof item === "string" ? item : item.title));
    const existing = options.milestones ? current.items.map((item) => ({ title: item.title, goals: (item.subtasks[0]?.items || []).map((goal) => goal.title) })) : current.items.map((item) => item.title);
    if (requested.length && JSON.stringify(requested) !== JSON.stringify(existing)) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "Continuation cannot redefine existing scope; update explicit items or use an authorized replacement.");
    return current;
  }
  if (options.replace || !current || current.items.length === 0 || current.lifecycle?.status !== "active" || isRoadmapSettledNormalized(current)) {
    return options.milestones ? createPlanRoadmap(title, options.milestones, options) : createRoadmap(title, items, options);
  }
  return addSubtaskRoadmap(current, title, items, options);
}

function refreshActiveHierarchy(roadmap) {
  if (!roadmap) return roadmap;
  for (const item of roadmap.items) for (const subtask of item.subtasks || []) refreshActiveHierarchy(subtask);
  ensureActiveItem(roadmap);
  return roadmap;
}
function addEvidenceBinding(item, evidenceId, options = {}) {
  if (!evidenceId) return null;
  const evidenceIdText = String(evidenceId);
  const validation = typeof options.validateEvidenceId === "function" ? options.validateEvidenceId(evidenceIdText) : null;
  if (!(validation === true || validation?.ok === true)) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_EVIDENCE, `Evidence packet is not current and passing: ${evidenceIdText}`);
  const provenance = options.provenance || "work-backed";
  const binding = { evidenceId: evidenceIdText, evidenceFingerprint: validation?.evidence?.fingerprint ? String(validation.evidence.fingerprint) : null, itemFingerprint: itemContentFingerprint(item), linkedAt: nowIso(), provenance: ["work-backed", "batch", "backfill", "manual"].includes(provenance) ? provenance : "work-backed", validated: true };
  item.evidenceIds = [...new Set([...(item.evidenceIds || []), binding.evidenceId])];
  item.evidenceBindings = [...(item.evidenceBindings || []).filter((entry) => entry.evidenceId !== binding.evidenceId), binding].slice(-20);
  return binding;
}
function currentEvidenceBindings(item) {
  const fingerprint = itemContentFingerprint(item);
  return (item.evidenceBindings || []).filter((binding) => binding.validated === true && binding.itemFingerprint === fingerprint);
}
function hasCurrentEvidence(item) { return currentEvidenceBindings(item).length > 0; }

function setActive(state, ref) {
  const next = normalizeRoadmap(state);
  const location = locateItem(next, ref);
  if (!location) throw roadmapError(ROADMAP_ERROR_CODES.STALE_ITEM, `Roadmap item is stale or missing: ${ref}`);
  if (location.roadmap.lifecycle?.status !== "active" || !isItemActionable(location.item)) throw roadmapError(ROADMAP_ERROR_CODES.LIFECYCLE_CONFLICT, `Roadmap item is not actionable: ${ref}`);
  activateLocation(location);
  return stamp(next, location.roadmap);
}

// Descendants of a location in post-order, so a parent is settled last.
function descendantLocations(location, output = []) {
  const ancestors = [...(location.ancestors || []), { item: location.item, roadmap: location.roadmap, path: location.path, roadmapPath: location.roadmapPath }];
  for (let subtaskIndex = 0; subtaskIndex < (location.item.subtasks || []).length; subtaskIndex++) {
    const subtask = location.item.subtasks[subtaskIndex];
    const roadmapPath = [...location.path, subtaskIndex + 1];
    for (let itemIndex = 0; itemIndex < subtask.items.length; itemIndex++) {
      const nested = { item: subtask.items[itemIndex], roadmap: subtask, path: [...roadmapPath, itemIndex + 1], roadmapPath, ancestors };
      descendantLocations(nested, output);
      output.push(nested);
    }
  }
  return output;
}

function memoizedEvidenceValidator(validate) {
  if (typeof validate !== "function") return validate;
  const cache = new Map();
  return (evidenceId) => {
    if (!cache.has(evidenceId)) cache.set(evidenceId, validate(evidenceId));
    return cache.get(evidenceId);
  };
}

function applyItemStatus(location, ref, requestedStatus, options = {}) {
  const item = location.item;
  let status = requestedStatus;
  if (FINAL_STATUSES.has(status) && item.subtasks.some((subtask) => !isRoadmapSettledNormalized(subtask))) {
    throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Cannot mark ${ref} ${status}: one or more nested subtask roadmaps remain incomplete.`);
  }
  if (status === "active" && location.roadmap.lifecycle?.status !== "active") throw roadmapError(ROADMAP_ERROR_CODES.LIFECYCLE_CONFLICT, `Cannot activate ${ref}: its roadmap is ${location.roadmap.lifecycle?.status || "inactive"}.`);
  if (options.evidenceId) addEvidenceBinding(item, options.evidenceId, options);
  if (status === "verified") {
    if (!hasCurrentEvidence(item)) {
      if (options.allowUnsubstantiated === true) status = "verified-unsubstantiated";
      else if ((item.evidenceBindings || []).length || (item.evidenceIds || []).length) throw roadmapError(ROADMAP_ERROR_CODES.STALE_EVIDENCE, `Cannot verify ${ref}: linked evidence does not match the current item content.`);
      else throw roadmapError(ROADMAP_ERROR_CODES.EVIDENCE_REQUIRED, `Cannot verify ${ref}: current linked verifier evidence is required.`);
    }
  }
  if (status === "verified-unsubstantiated" && options.allowUnsubstantiated !== true) throw roadmapError(ROADMAP_ERROR_CODES.EVIDENCE_REQUIRED, `Cannot mark ${ref} verified-unsubstantiated without an explicit override.`);
  const from = item.status;
  item.status = status;
  if (options.note) item.notes = [...(item.notes || []), String(options.note)].slice(-20);
  if (options.artifactId) item.artifactIds = [...new Set([...(item.artifactIds || []), String(options.artifactId)])];
  item.transitions = [...(item.transitions || []), normalizeTransition({ from, to: status, provenance: status === "verified-unsubstantiated" ? "override" : options.provenance || (options.evidenceId ? "work-backed" : "manual"), evidenceBound: hasCurrentEvidence(item) })].slice(-20);
  if (status === "active") activateLocation(location);
  else if (location.roadmap.activeItemId === item.id || FINAL_STATUSES.has(status) || NONACTIONABLE_STATUSES.has(status)) {
    if (location.roadmap.activeItemId === item.id) location.roadmap.activeItemId = undefined;
    return { status, refresh: true };
  }
  return { status, refresh: false };
}

function setStatus(state, ref, requestedStatus, options = {}) {
  return setStatusMany(state, [ref], requestedStatus, options);
}

// One call settles several items, optionally cascading to their nested
// descendants, so a finished phase does not need one tool call per goal.
// Validation happens before any mutation; a rejected reference or status
// leaves the caller's state untouched.
function setStatusMany(state, refs, requestedStatus, options = {}) {
  if (!validStatus(requestedStatus)) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Invalid roadmap status: ${requestedStatus}`);
  const next = normalizeRoadmap(state);
  const targets = [...new Set((Array.isArray(refs) ? refs : [refs]).map((ref) => cleanText(ref)).filter(Boolean))];
  if (!targets.length) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "A roadmap status update requires at least one item reference.");
  const work = [];
  const seen = new Set();
  for (const ref of targets) {
    const location = locateItem(next, ref);
    if (!location) throw roadmapError(ROADMAP_ERROR_CODES.STALE_ITEM, `Roadmap item is stale or missing: ${ref}`);
    if (options.cascade === true) {
      for (const descendant of descendantLocations(location)) {
        if (seen.has(descendant.item.id) || !["pending", "active"].includes(descendant.item.status)) continue;
        seen.add(descendant.item.id);
        work.push({ location: descendant, ref: descendant.path.join(".") });
      }
    }
    if (seen.has(location.item.id)) continue;
    seen.add(location.item.id);
    work.push({ location, ref });
  }
  const validateEvidenceId = memoizedEvidenceValidator(options.validateEvidenceId);
  const touched = new Set();
  let refresh = false;
  for (const entry of work) {
    const applied = applyItemStatus(entry.location, entry.ref, requestedStatus, { ...options, validateEvidenceId });
    touched.add(entry.location.roadmap);
    if (applied.refresh) refresh = true;
  }
  if (refresh && options.autoAdvance !== false) refreshActiveHierarchy(next);
  for (const roadmap of touched) stamp(next, roadmap);
  return next;
}

function linkItem(state, ref, options = {}) {
  const { artifactId, evidenceId, note, provenance } = options;
  const next = normalizeRoadmap(state);
  const location = locateItem(next, ref);
  if (!location) throw roadmapError(ROADMAP_ERROR_CODES.STALE_ITEM, `Roadmap item is stale or missing: ${ref}`);
  const item = location.item;
  if (artifactId) item.artifactIds = [...new Set([...(item.artifactIds || []), String(artifactId)])];
  if (evidenceId) addEvidenceBinding(item, evidenceId, { ...options, provenance: provenance || "manual" });
  if (note) item.notes = [...(item.notes || []), String(note)].slice(-20);
  return stamp(next, location.roadmap);
}

function linkItems(state, refs, options = {}) {
  const targets = [...new Set((Array.isArray(refs) ? refs : [refs]).map((ref) => cleanText(ref)).filter(Boolean))];
  if (!targets.length) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, "Linking requires at least one item reference.");
  let next = state;
  for (const ref of targets) next = linkItem(next, ref, options);
  return next;
}

function setRoadmapLifecycle(state, status, options = {}) {
  if (!["closed", "shelved", "active", "archived"].includes(status)) throw roadmapError(ROADMAP_ERROR_CODES.INVALID_OPERATION, `Invalid roadmap lifecycle status: ${status}`);
  const next = normalizeRoadmap(state);
  if (!next) throw roadmapError(ROADMAP_ERROR_CODES.MISSING_PARENT, "No roadmap active.");
  const target = options.roadmapId ? locateRoadmap(next, options.roadmapId) : { roadmap: next };
  if (!target) throw roadmapError(ROADMAP_ERROR_CODES.MISSING_PARENT, `Roadmap not found: ${options.roadmapId}`);
  const roadmap = target.roadmap;
  const progress = progressForNormalized(roadmap);
  if (status === "closed" && progress.actionable > 0 && options.force !== true) throw roadmapError(ROADMAP_ERROR_CODES.LIFECYCLE_CONFLICT, `Cannot close a roadmap with ${progress.actionable} actionable item(s); shelve it or complete the work.`);
  if (status === "active" && !["closed", "shelved"].includes(roadmap.lifecycle?.status)) throw roadmapError(ROADMAP_ERROR_CODES.LIFECYCLE_CONFLICT, `Cannot resume a roadmap whose lifecycle is ${roadmap.lifecycle?.status || "active"}.`);
  roadmap.lifecycle = { status, changedAt: nowIso(), reason: options.reason ? cleanText(options.reason) : undefined };
  if (status !== "active") {
    for (const item of roadmap.items) if (item.status === "active") item.status = "pending";
    roadmap.activeItemId = undefined;
  } else refreshActiveHierarchy(roadmap);
  if (status === "closed" && target.parentItem && isRoadmapSettledNormalized(roadmap) && isItemActionable(target.parentItem)) {
    activateLocation(locateItem(next, target.parentItem.id));
  }
  return stamp(next, roadmap);
}

function progressForNormalized(roadmap) {
  const flattened = flattenItems(roadmap);
  const context = activeContext(roadmap);
  const activePath = context.activePath;
  const unresolvedRows = flattened.filter(({ item }) => !FINAL_STATUSES.has(item.status));
  const actionableRows = unresolvedRows.filter(({ item, roadmap: owner }) => owner.lifecycle?.status === "active" && isItemActionable(item));
  const evidenceBindings = flattened.reduce((sum, { item }) => sum + currentEvidenceBindings(item).length, 0);
  const unsupportedVerification = flattened.filter(({ item }) => item.status === "verified-unsubstantiated" || (item.status === "verified" && !hasCurrentEvidence(item))).length;
  const provenance = { workBacked: 0, batch: 0, backfill: 0, override: 0, manual: 0, migration: 0 };
  for (const { item } of flattened) for (const transition of item.transitions || []) {
    if (transition.provenance === "work-backed") provenance.workBacked++;
    else if (transition.provenance === "batch") provenance.batch++;
    else if (transition.provenance === "backfill") provenance.backfill++;
    else if (transition.provenance === "override") provenance.override++;
    else if (transition.provenance === "migration") provenance.migration++;
    else provenance.manual++;
  }
  // Root items are the stable required-outcome denominator. Temporary helper
  // descendants affect workflow counts, not the number of product outcomes.
  const outcomes = {
    total: roadmap.items.length,
    complete: roadmap.items.filter((item) => COMPLETE_STATUSES.has(item.status)).length,
    verified: roadmap.items.filter((item) => item.status === "verified" && hasCurrentEvidence(item)).length,
    // A root outcome is substantiated once its current evidence binding still
    // validates; `done` records implementation progress, so the verification
    // gate must not require a redundant `verified` label on top of that proof.
    substantiated: roadmap.items.filter((item) => COMPLETE_STATUSES.has(item.status) && hasCurrentEvidence(item)).length,
    blocked: roadmap.items.filter((item) => item.status === "blocked" || item.subtasks.some((subtask) => flattenItems(subtask).some((row) => row.item.status === "blocked"))).length,
  };
  return {
    outcomes,
    total: flattened.length,
    complete: flattened.filter(({ item }) => COMPLETE_STATUSES.has(item.status)).length,
    verified: flattened.filter(({ item }) => item.status === "verified" && hasCurrentEvidence(item)).length,
    unsupportedVerification,
    evidenceBindings,
    blocked: flattened.filter(({ item }) => item.status === "blocked").length,
    paused: flattened.filter(({ item }) => item.status === "paused").length,
    shelved: flattened.filter(({ item }) => item.status === "shelved").length,
    skipped: flattened.filter(({ item }) => item.status === "skipped").length,
    pending: flattened.filter(({ item }) => item.status === "pending").length,
    unresolved: unresolvedRows.length,
    actionable: actionableRows.length,
    nonActionable: unresolvedRows.length - actionableRows.length,
    maxDepth: flattened.reduce((max, row) => Math.max(max, Math.ceil(row.path.length / 2)), 0),
    transitionProvenance: provenance,
    lifecycle: roadmap.lifecycle?.status || "active",
    active: activePath.at(-1)?.item || null,
    activePath,
    activeRoadmap: context.roadmap,
  };
}
function getProgress(state) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return { outcomes: { total: 0, complete: 0, verified: 0, blocked: 0 }, total: 0, complete: 0, verified: 0, unsupportedVerification: 0, evidenceBindings: 0, blocked: 0, paused: 0, shelved: 0, skipped: 0, active: null, activePath: [], activeRoadmap: null, pending: 0, unresolved: 0, actionable: 0, nonActionable: 0, maxDepth: 0, lifecycle: "none", transitionProvenance: {} };
  return progressForNormalized(normalized);
}

function isRoadmapComplete(state) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return false;
  const flattened = flattenItems(normalized);
  return flattened.length > 0 && flattened.every(({ item }) => COMPLETE_STATUSES.has(item.status));
}

function isUserMessageInput(event = {}) {
  return event?.source === "interactive" || event?.source === "rpc";
}

function roadmapInputDisposition(state, event = {}) {
  const text = String(event?.text || "").trim();
  if (!isUserMessageInput(event) || !text || text.startsWith("/")) return "ignore";
  if (isRoadmapComplete(state)) return "clear-complete";
  const progress = getProgress(state);
  if (progress.actionable > 0) return "retain-actionable";
  if (progress.unresolved > 0 || progress.lifecycle !== "none") return "retain-nonactionable";
  return "ignore";
}
function shouldClearCompletedRoadmapOnInput(state, event = {}) {
  return roadmapInputDisposition(state, event) === "clear-complete";
}

// Display-only snapshot for local and remote viewers. Keep the nested detail
// bounded independently of persisted state and disclose omitted entries.
function roadmapSnapshot(state) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return null;
  const progress = progressForNormalized(normalized);
  return {
    title: normalized.title,
    lifecycle: progress.lifecycle,
    complete: progress.complete,
    total: progress.total,
    blocked: progress.blocked,
    milestones: normalized.items.map((item) => ({ title: item.title, status: item.status })),
    activePath: progress.activePath.map(({ item, path }) => ({ title: item.title, status: item.status, path: path.join(".") })),
    viewer: roadmapViewerSnapshot(normalized, progress),
  };
}

function roadmapViewerSnapshot(normalized, progress) {
  const all = roadmapDisplayEntries(normalized);
  const entries = [];
  let bytes = 2; // JSON array brackets.
  for (const entry of all.slice(0, 500)) {
    const value = entry.type === "item" ? entry.item : entry.roadmap;
    const row = {
      kind: entry.type,
      path: entry.path.join("."),
      title: cleanText(value.title).slice(0, 500),
      status: entry.type === "item" ? value.status : value.lifecycle.status,
      notes: (value.notes || []).slice(-3).map((note) => cleanText(note).slice(0, 200)),
    };
    bytes += Buffer.byteLength(JSON.stringify(row), "utf8") + (entries.length ? 1 : 0);
    if (bytes > 64 * 1024) break;
    entries.push(row);
  }
  return {
    id: normalized.id,
    updatedAt: normalized.updatedAt,
    outcomes: { complete: progress.outcomes.complete, total: progress.outcomes.total, blocked: progress.outcomes.blocked },
    entries,
    totalEntries: all.length,
  };
}

function summaryLine(state) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return "No roadmap active";
  const progress = progressForNormalized(normalized);
  const parts = [`🧭 ${normalized.title}`, `outcomes ${progress.outcomes.complete}/${progress.outcomes.total}`, `workflow ${progress.complete}/${progress.total} done`];
  if (progress.outcomes.blocked) parts.push(`${progress.outcomes.blocked} blocked outcomes`);
  if (progress.lifecycle !== "active") parts.push(`lifecycle: ${progress.lifecycle}`);
  if (progress.blocked) parts.push(`${progress.blocked} blocked`);
  if (progress.nonActionable) parts.push(`${progress.nonActionable} nonactionable`);
  if (progress.unsupportedVerification) parts.push(`${progress.unsupportedVerification} unsupported verification`);
  if (progress.activePath.length) parts.push(`active: ${progress.activePath.map(({ item }) => item.title).join(" › ")}`);
  else if (progress.unresolved) parts.push("active: none");
  return parts.join(" · ");
}

const GLYPHS = Object.freeze({ pending: "☐", active: "▶", done: "✓", verified: "◆", "verified-unsubstantiated": "◇", blocked: "⚠", paused: "Ⅱ", shelved: "▣", skipped: "↷", archived: "▤" });
function itemLine(item, label, options = {}) {
  const indent = "  ".repeat(options.depth || 0);
  const prefix = options.includeIds === false ? GLYPHS[item.status] || "☐" : `${GLYPHS[item.status] || "☐"} #${label}`;
  const links = [];
  if (item.sourceArtifactId) links.push(`src:${item.sourceArtifactId}`);
  if (item.artifactIds?.length) links.push(`art:${item.artifactIds.length}`);
  if (item.evidenceIds?.length) links.push(`ev:${item.evidenceIds.length}`);
  return `${indent}${prefix} ${item.title}${links.length ? ` (${links.join(", ")})` : ""}`;
}
function roadmapDisplayEntries(roadmap, roadmapPath = [], depth = 0, output = []) {
  for (let itemIndex = 0; itemIndex < roadmap.items.length; itemIndex++) {
    const item = roadmap.items[itemIndex];
    const itemPath = [...roadmapPath, itemIndex + 1];
    output.push({ type: "item", path: itemPath, item, line: itemLine(item, itemPath.join("."), { includeIds: true, depth }) });
    for (let subtaskIndex = 0; subtaskIndex < item.subtasks.length; subtaskIndex++) {
      const subtask = item.subtasks[subtaskIndex];
      const subtaskPath = [...itemPath, subtaskIndex + 1];
      const progress = progressForNormalized(subtask);
      const source = subtask.sourceArtifactId ? ` · src:${subtask.sourceArtifactId}` : "";
      output.push({
        type: "roadmap",
        path: subtaskPath,
        roadmap: subtask,
        line: `${"  ".repeat(depth + 1)}↳ @${subtaskPath.join(".")} ${subtask.title} · ${progress.complete}/${progress.total} done${progress.blocked ? ` · ${progress.blocked} blocked` : ""}${source}`,
      });
      roadmapDisplayEntries(subtask, subtaskPath, depth + 2, output);
    }
  }
  return output;
}

function formatWidgetLines(state, options = {}) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return [];
  const rawMaxItems = Number(options.maxItems || 6);
  const maxItems = Number.isFinite(rawMaxItems) ? Math.max(1, rawMaxItems) : 6;
  const lines = [summaryLine(normalized)];
  const entries = roadmapDisplayEntries(normalized);
  const activePath = progressForNormalized(normalized).activePath.at(-1)?.path;
  const activeIndex = activePath ? entries.findIndex((entry) => entry.type === "item" && samePath(entry.path, activePath)) : -1;
  let start = 0;
  if (activeIndex >= maxItems) start = Math.max(0, activeIndex - Math.floor(maxItems / 2));
  const visible = entries.slice(start, start + maxItems);
  if (start > 0) lines.push(`… ${start} earlier line(s)`);
  lines.push(...visible.map((entry) => entry.line));
  const hiddenAfter = entries.length - (start + visible.length);
  if (hiddenAfter > 0) lines.push(`… ${hiddenAfter} later line(s)`);
  if (!entries.length) lines.push("☐ No items yet. Use /roadmap-add <step>.");
  return lines;
}

function pathStartsWith(candidate, prefix) { return prefix.every((part, index) => candidate[index] === part); }
function roadmapPage(state, options = {}) {
  const normalized = normalizeRoadmap(state);
  if (!normalized) return { text: "No roadmap active. Use /roadmap-start <title>.", offset: 0, limit: 0, totalEntries: 0, hasMore: false, nextOffset: null, focused: false };
  const requestedLimit = Number(options.limit ?? 100);
  const limit = Math.min(200, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
  const requestedOffset = Number(options.offset || 0);
  const offset = Math.max(0, Number.isFinite(requestedOffset) ? Math.floor(requestedOffset) : 0);
  let entries = roadmapDisplayEntries(normalized);
  let focusPath = null;
  if (options.focusId) {
    const item = locateItem(normalized, options.focusId);
    const roadmap = locateRoadmap(normalized, options.focusId);
    focusPath = item?.path || roadmap?.path || null;
    if (!focusPath) throw roadmapError(ROADMAP_ERROR_CODES.STALE_ITEM, `Roadmap focus is stale or missing: ${options.focusId}`);
    entries = entries.filter((entry) => pathStartsWith(entry.path, focusPath));
  }
  const page = entries.slice(offset, offset + limit);
  const lines = [summaryLine(normalized), `ID: ${normalized.id}`, `Source: ${normalized.source}${normalized.sourceArtifactId ? ` (${normalized.sourceArtifactId})` : ""}`, `Page: ${offset + 1}-${offset + page.length} of ${entries.length}${focusPath ? ` · focus ${focusPath.join(".")}` : ""}`, ""];
  for (const entry of page) {
    lines.push(entry.line);
    if (entry.type === "item" && entry.item.notes?.length) {
      const indent = "  ".repeat(Math.max(1, Math.floor(entry.path.length / 2) + 1));
      for (const note of entry.item.notes.slice(-3)) lines.push(`${indent}note: ${cleanText(note).slice(0, 200)}`);
    }
  }
  if (!page.length) lines.push("(no entries on this page)");
  const hasMore = offset + page.length < entries.length;
  if (hasMore) lines.push(`… ${entries.length - (offset + page.length)} later entries; request offset ${offset + page.length}`);
  const rawMaxChars = Number(options.maxChars ?? 12000);
  const maxChars = Math.min(20000, Math.max(500, Number.isFinite(rawMaxChars) ? Math.floor(rawMaxChars) : 12000));
  let text = lines.join("\n");
  let truncated = false;
  if (text.length > maxChars) {
    text = `${text.slice(0, Math.max(0, maxChars - 80)).replace(/\n[^\n]*$/, "")}\n… output truncated at ${maxChars} characters; use focus/offset/limit`;
    truncated = true;
  }
  return { text, offset, limit, totalEntries: entries.length, returnedEntries: page.length, hasMore, nextOffset: hasMore ? offset + page.length : null, focused: Boolean(focusPath), truncated, maxChars };
}
function formatRoadmapText(state, options = {}) { return roadmapPage(state, options).text; }

function readReasoningArtifacts(cwd, options = {}) {
  const file = reasoningStateFile(cwd);
  const requestedMaxBytes = Number(options.maxBytes || process.env.PI_INTEGRATION_STORAGE_MAX_JSON_BYTES || 64 * 1024 * 1024);
  const maxBytes = Number.isFinite(requestedMaxBytes) && requestedMaxBytes >= 1024 ? requestedMaxBytes : 64 * 1024 * 1024;
  let size = 0;
  try { size = fs.statSync(file).size; }
  catch { return { file, artifacts: [] }; }
  if (size > maxBytes) return { file, artifacts: [], oversized: true, size, maxBytes };
  let packet;
  try { packet = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return { file, artifacts: [] }; }
  return { file, artifacts: Array.isArray(packet.artifacts) ? packet.artifacts : [], oversized: false, size, maxBytes };
}

function artifactTime(artifact) {
  const t = Date.parse(artifact?.updatedAt || artifact?.createdAt || 0);
  return Number.isFinite(t) ? t : 0;
}
function artifactItems(artifact) {
  if (!artifact) return [];
  if (artifact.type === "plan") return Array.isArray(artifact.steps) ? artifact.steps : [];
  if (artifact.type === "task_decomposition") return Array.isArray(artifact.subtasks) ? artifact.subtasks : [];
  return [];
}
function artifactTitle(artifact) { return cleanText(artifact?.objective || artifact?.task || artifact?.summary || artifact?.publicSummary, "Reasoning roadmap"); }
function isAutoScaffold(artifact) { return artifact?.source === "model-scaffold" || artifact?.metadata?.source === "model-scaffold"; }
function mapArtifactStatus(status) {
  const s = String(status || "pending").toLowerCase();
  if (["done", "complete", "completed"].includes(s)) return "done";
  if (["verified", "accepted"].includes(s)) return "verified";
  if (["active", "running", "in_progress", "in-progress"].includes(s)) return "active";
  if (["blocked", "failed"].includes(s)) return "blocked";
  if (["skipped", "cancelled", "canceled"].includes(s)) return "skipped";
  return "pending";
}
function pickReasoningArtifact(artifacts) {
  const candidates = artifacts
    .filter((artifact) => ["plan", "task_decomposition"].includes(artifact?.type))
    .filter((artifact) => artifactItems(artifact).length > 0)
    .map((artifact) => ({ artifact, nonScaffold: isAutoScaffold(artifact) ? 0 : 1, time: artifactTime(artifact), richness: artifactItems(artifact).length }));
  candidates.sort((a, b) => (b.nonScaffold - a.nonScaffold) || (b.time - a.time) || (b.richness - a.richness));
  return candidates[0]?.artifact || null;
}

function importFromReasoning(cwd, options = {}) {
  const { file, artifacts, oversized, size, maxBytes } = readReasoningArtifacts(cwd, options);
  if (oversized) return { imported: false, file, reason: `Reasoning state is oversized (${size} bytes; limit ${maxBytes}) and was not loaded.`, oversized: true, size, maxBytes, roadmap: null };
  const artifact = pickReasoningArtifact(artifacts);
  if (!artifact) return { imported: false, file, reason: "No plan/task_decomposition artifacts with steps found.", roadmap: null };
  const items = artifactItems(artifact).map((step, index) => {
    const raw = typeof step === "string" ? { description: step } : (step || {});
    return normalizeItem({
      id: `item-${index + 1}`,
      title: raw.title || raw.description || raw.text || raw.id || `Step ${index + 1}`,
      status: mapArtifactStatus(raw.status),
      source: artifact.type === "plan" ? "reasoning-plan" : "task-decomposition",
      sourceArtifactId: artifact.id,
      sourceStepId: raw.id || raw.step || undefined,
      artifactIds: [artifact.id].filter(Boolean),
    }, index);
  });
  const roadmap = createRoadmap(artifactTitle(artifact), items, { source: artifact.type === "plan" ? "reasoning-plan" : "task-decomposition", sourceArtifactId: artifact.id });
  return { imported: true, file, artifactId: artifact.id, artifactType: artifact.type, roadmap };
}

function roadmapMutationMetadata(previous, next) {
  const beforeIds = new Set();
  const collect = (roadmap) => {
    if (!roadmap) return;
    beforeIds.add(roadmap.id);
    for (const item of roadmap.items || []) for (const subtask of item.subtasks || []) collect(subtask);
  };
  collect(normalizeRoadmap(previous));
  let found = null;
  const visit = (roadmap, parentRoadmap = null, parentItem = null) => {
    if (!roadmap || found) return;
    if (!beforeIds.has(roadmap.id)) {
      found = { roadmap, parentRoadmap, parentItem };
      return;
    }
    for (const item of roadmap.items || []) for (const subtask of item.subtasks || []) visit(subtask, roadmap, item);
  };
  visit(normalizeRoadmap(next));
  if (!found) return { nested: false, roadmapId: next?.id || null, roadmapTitle: next?.title || null, parentRoadmapId: null, parentRoadmapTitle: null, parentItemId: null, parentItemTitle: null };
  return {
    nested: Boolean(found.parentRoadmap),
    roadmapId: found.roadmap.id,
    roadmapTitle: found.roadmap.title,
    parentRoadmapId: found.parentRoadmap?.id || null,
    parentRoadmapTitle: found.parentRoadmap?.title || null,
    parentItemId: found.parentItem?.id || null,
    parentItemTitle: found.parentItem?.title || null,
  };
}

function roadmapStateMetrics(state) {
  const progress = getProgress(state);
  return {
    itemCount: progress.total,
    maxDepth: progress.maxDepth,
    actionableCount: progress.actionable,
    nonActionableCount: progress.nonActionable,
    blockedCount: progress.blocked,
    unsupportedVerificationCount: progress.unsupportedVerification,
    evidenceBindingCount: progress.evidenceBindings,
    settled: isRoadmapSettled(state),
  };
}
function publicChangedItem(row) {
  return {
    id: row.item.id,
    path: row.path.join("."),
    title: cleanText(row.item.title).slice(0, 120),
    status: row.item.status,
    evidenceBindings: currentEvidenceBindings(row.item).length,
  };
}
/** Compact text for the model: the same fields as the envelope, without JSON indentation or repeated keys. */
function roadmapMutationText(envelope) {
  const delta = envelope.delta || {};
  const progress = envelope.progress || {};
  const outcomes = progress.outcomes || {};
  const target = envelope.roadmap ? `${envelope.roadmap.id} (${envelope.roadmap.lifecycle})` : "no active roadmap";
  const lines = [`roadmap ${envelope.operation}: ${target}`];
  const ids = Array.isArray(delta.appliedIds) && delta.appliedIds.length ? ` · ids ${delta.appliedIds.join(", ")}` : "";
  lines.push(`delta: ${delta.changedCount || 0} changed, ${delta.removedCount || 0} removed${ids}`);
  for (const item of delta.changed || []) lines.push(`- ${item.path} ${item.status}${item.title ? ` ${item.title}` : ""}${item.evidenceBindings ? ` evidence=${item.evidenceBindings}` : ""}`);
  if (delta.changedRoadmap) lines.push(`roadmap ${delta.changedRoadmap.id} nested=${Boolean(delta.changedRoadmap.nested)}${delta.changedRoadmap.parentItemId ? ` parent=${delta.changedRoadmap.parentItemId}` : ""}`);
  const extras = [];
  if (progress.blocked) extras.push(`blocked ${progress.blocked}`);
  if (progress.nonActionable) extras.push(`non-actionable ${progress.nonActionable}`);
  if (progress.unsupportedVerification) extras.push(`unsubstantiated ${progress.unsupportedVerification}`);
  if (progress.evidenceBindings) extras.push(`evidence ${progress.evidenceBindings}`);
  lines.push(`progress: ${progress.complete ?? 0}/${progress.total ?? 0} complete · outcomes ${outcomes.complete ?? 0}/${outcomes.total ?? 0} · unresolved ${progress.unresolved ?? 0} · actionable ${progress.actionable ?? 0}${extras.length ? ` · ${extras.join(" · ")}` : ""}`);
  if (Array.isArray(envelope.activePath) && envelope.activePath.length) lines.push(`active: ${envelope.activePath.map((entry) => `${entry.path} ${entry.status}${entry.title ? ` ${entry.title}` : ""}`).join(" > ")}`);
  if (envelope.hint) lines.push(`hint: ${envelope.hint}`);
  return lines.join("\n");
}

function roadmapMutationEnvelope(previous, next, operation = "update", options = {}) {
  const before = normalizeRoadmap(previous);
  const after = normalizeRoadmap(next);
  const beforeMap = new Map((before ? flattenItems(before) : []).map((row) => [row.item.id, row]));
  const afterRows = after ? flattenItems(after) : [];
  const changedRows = afterRows.filter((row) => {
    const prior = beforeMap.get(row.item.id);
    return !prior || prior.item.status !== row.item.status || itemContentFingerprint(prior.item) !== itemContentFingerprint(row.item) || (prior.item.notes || []).length !== (row.item.notes || []).length || currentEvidenceBindings(prior.item).length !== currentEvidenceBindings(row.item).length;
  });
  const removed = (before ? flattenItems(before) : []).filter((row) => !afterRows.some((candidate) => candidate.item.id === row.item.id));
  const progress = getProgress(after);
  const mutation = roadmapMutationMetadata(before, after);
  const envelope = {
    schemaVersion: MUTATION_ENVELOPE_VERSION,
    kind: "roadmap-mutation",
    operation,
    roadmap: after ? { id: after.id, lifecycle: after.lifecycle?.status || "active" } : null,
    delta: {
      changedCount: changedRows.length,
      removedCount: removed.length,
      appliedIds: changedRows.slice(0, 12).map((row) => row.item.id),
      changed: changedRows.slice(0, 3).map(publicChangedItem),
      changedRoadmap: mutation.roadmapId ? { id: mutation.roadmapId, nested: mutation.nested, parentRoadmapId: mutation.parentRoadmapId, parentItemId: mutation.parentItemId } : null,
    },
    progress: {
      outcomes: progress.outcomes,
      complete: progress.complete,
      total: progress.total,
      unresolved: progress.unresolved,
      actionable: progress.actionable,
      nonActionable: progress.nonActionable,
      blocked: progress.blocked,
      unsupportedVerification: progress.unsupportedVerification,
      evidenceBindings: progress.evidenceBindings,
    },
    activePath: (progress.activePath || []).slice(-8).map((entry) => ({ id: entry.item.id, path: entry.path.join("."), title: cleanText(entry.item.title).slice(0, 100), status: entry.item.status })),
    fullState: false,
    hint: "Use action=show with focusId/offset/limit for bounded detail.",
  };
  let text = roadmapMutationText(envelope);
  const maxChars = Math.min(2500, Math.max(800, Number(options.maxChars || 2500)));
  if (text.length > maxChars) {
    envelope.delta.changed = envelope.delta.changed.map(({ id, path, status, evidenceBindings }) => ({ id, path, status, evidenceBindings }));
    envelope.activePath = envelope.activePath.map(({ id, path, status }) => ({ id, path, status }));
    text = roadmapMutationText(envelope);
  }
  if (text.length > maxChars) {
    envelope.delta.changed = [];
    envelope.activePath = envelope.activePath.slice(-3);
    text = roadmapMutationText(envelope);
  }
  if (text.length > maxChars) text = `${text.slice(0, Math.max(0, maxChars - 80)).replace(/\n[^\n]*$/, "")}\n… output truncated at ${maxChars} characters; use action=show for detail`;
  return { envelope, text, resultChars: text.length, deltaChars: JSON.stringify(envelope.delta).length };
}
function finalReportSummary(state) {
  const normalized = normalizeRoadmap(state);
  const progress = getProgress(normalized);
  return {
    schemaVersion: 1,
    roadmapId: normalized?.id || null,
    lifecycle: normalized?.lifecycle?.status || "none",
    outcomes: progress.outcomes,
    counts: {
      total: progress.total,
      complete: progress.complete,
      substantiatedVerified: progress.verified,
      substantiatedOutcomes: progress.outcomes.substantiated,
      unsupportedVerification: progress.unsupportedVerification,
      unresolvedActionable: progress.actionable,
      unresolvedNonActionable: progress.nonActionable,
      blocked: progress.blocked,
    },
    completionClaimAllowed: Boolean(normalized && progress.outcomes.total > 0 && progress.outcomes.complete === progress.outcomes.total && progress.unresolved === 0 && progress.unsupportedVerification === 0),
    verificationClaimAllowed: Boolean(normalized && progress.outcomes.total > 0 && progress.outcomes.substantiated === progress.outcomes.total && progress.unresolved === 0 && progress.unsupportedVerification === 0),
    activePath: (progress.activePath || []).map((entry) => ({ id: entry.item.id, path: entry.path.join("."), status: entry.item.status })),
  };
}

function parseStartArgs(args = "") {
  const text = String(args || "").trim();
  const [titlePart, itemsPart] = text.split(/\s*::\s*/, 2);
  const title = cleanText(titlePart, "Roadmap");
  const items = itemsPart ? itemsPart.split(/\s*\|\s*/).map((s) => cleanText(s)).filter(Boolean) : [];
  return { title, items };
}

module.exports = {
  ROADMAP_VERSION,
  MUTATION_ENVELOPE_VERSION,
  ROADMAP_STATUSES,
  ROADMAP_LIFECYCLE_STATUSES,
  ROADMAP_ERROR_CODES,
  RoadmapError,
  resolveProjectRoot,
  roadmapRoot,
  roadmapDir,
  roadmapSessionScope,
  setRoadmapSessionScope,
  roadmapStoreCandidates,
  adoptRoadmap,
  stateFile,
  lastKnownGoodFile,
  archiveIndexFile,
  reasoningStateFile,
  createRoadmap,
  createPlanRoadmap,
  normalizeRoadmap,
  loadRoadmap,
  saveRoadmap,
  clearRoadmap,
  addItem,
  addItems,
  addSubtaskRoadmap,
  startRoadmap,
  setActive,
  setStatus,
  setStatusMany,
  setRoadmapLifecycle,
  linkItem,
  linkItems,
  itemContentFingerprint,
  currentEvidenceBindings,
  hasCurrentEvidence,
  revalidateEvidenceBindings,
  findItem,
  getActivePath,
  getProgress,
  isRoadmapComplete,
  isRoadmapSettled,
  roadmapSnapshot,
  roadmapInputDisposition,
  shouldClearCompletedRoadmapOnInput,
  summaryLine,
  formatWidgetLines,
  roadmapPage,
  formatRoadmapText,
  finalReportSummary,
  roadmapStateMetrics,
  readReasoningArtifacts,
  importFromReasoning,
  pickReasoningArtifact,
  roadmapMutationMetadata,
  roadmapMutationEnvelope,
  archiveRoadmapPacket,
  parseStartArgs,
};
