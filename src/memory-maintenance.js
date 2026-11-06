"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const memoryStateCatalog = require("./memory-state-catalog");
const { ProjectMemoryDecisionStore, writePrivateJson, appendPrivate, readJsonl } = require("./project-memory-decisions");
const { previewRetention, rootsFor: retentionRoots } = require("./state-retention");
const { previewManagedPermissions, managedRoots } = require("./managed-state-permissions");

const MEMORY_MAINTENANCE_SCHEMA_VERSION = 1;
const DEFAULT_LIMITS = Object.freeze({ maxCandidates: 500, maxRecords: 1000, maxDecisions: 500, maxEvidence: 1000, maxResolved: 500, maxElapsedMs: 5000 });
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const SENSITIVE_ID = /(?:^|[-_.:])(?:sk|token|secret|password|passwd|authorization|bearer|api[_-]?key)(?:[-_.:]|$)|^AKIA|^ghp_|^github_pat_/i;

function stable(value) { if (Array.isArray(value)) return value.map(stable); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])])); return value; }
function stableStringify(value) { return JSON.stringify(stable(value)); }
function digest(value, length = 32) { return crypto.createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex").slice(0, length); }
function readJson(file, fallback = null) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } }
function isSafeLocalPath(cwd, target) {
  const root = path.resolve(cwd); const resolved = path.resolve(target); const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) { current = path.join(current, segment); try { if (fs.lstatSync(current).isSymbolicLink()) return false; } catch (error) { if (error?.code === "ENOENT") return true; return false; } }
  return true;
}
function safeId(value, fallbackPrefix = "ref") { const text = String(value || "").trim(); return SAFE_ID.test(text) && !SENSITIVE_ID.test(text) ? text : `${fallbackPrefix}_${digest(text || fallbackPrefix, 20)}`; }
function decisionReasonCode(value) { return `reason_${digest(String(value || "unknown"), 16)}`; }
function candidate(category, sourceId, action, reasons = [], metadata = {}) {
  const normalizedReasons = [...new Set((reasons || []).map((item) => String(item).slice(0, 120)))].sort();
  const identity = { category, sourceId: safeId(sourceId), action: String(action || "review"), reasons: normalizedReasons };
  return {
    candidateId: `maint_${digest(identity, 24)}`,
    category,
    sourceId: identity.sourceId,
    action: identity.action,
    reasonCodes: normalizedReasons,
    fingerprint: `sha256:${digest({ identity, metadata }, 64)}`,
    metadata: stable(metadata),
  };
}
function publicDecision(row = {}) {
  return {
    decisionId: safeId(row.decisionId || "decision-missing", "decision"),
    action: String(row.action || "unknown"),
    reason: decisionReasonCode(row.reason),
    candidateHash: /^sha256:[a-f0-9]{64}$/.test(String(row.candidateHash || "")) ? row.candidateHash : null,
    noteRevision: /^[a-f0-9]{64}$/.test(String(row.noteRevision || "")) ? row.noteRevision : null,
    evidenceIds: (row.evidenceIds || []).map((id) => safeId(id, "evidence")).slice(0, 64),
    sourceFingerprints: (row.sourceFingerprints || []).map((id) => safeId(id, "source")).slice(0, 64),
    verification: String(row.verification || "unverified"),
  };
}
function reportCandidateRows(rows, maxCandidates) {
  const byId = new Map();
  for (const row of rows) if (!byId.has(row.candidateId)) byId.set(row.candidateId, row);
  const sorted = [...byId.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return { candidates: sorted.slice(0, maxCandidates), total: sorted.length, truncated: sorted.length > maxCandidates };
}
function elapsedExceeded(started, limit) { return Date.now() - started > limit; }

class MemoryMaintenanceAdapter {
  constructor({ enabled = true, cwd = process.cwd(), root, vault = null, home = null, limits = {}, clock = () => new Date() } = {}) {
    this.enabled = enabled !== false;
    this.cwd = path.resolve(cwd);
    this.root = path.resolve(root || path.join(this.cwd, ".pi", "memory-maintenance"));
    if (!this.root.startsWith(`${this.cwd}${path.sep}`) || !isSafeLocalPath(this.cwd, this.root)) throw new Error("memory maintenance root must stay inside a non-symlinked project state path");
    this.previewsRoot = path.join(this.root, "previews");
    this.latestFile = path.join(this.root, "latest.json");
    this.indexFile = path.join(this.root, "previews.jsonl");
    this.vault = vault ? path.resolve(vault) : null;
    this.home = home ? path.resolve(home) : path.join(this.root, "no-global-home");
    this.limits = { ...DEFAULT_LIMITS, ...(limits || {}) };
    this.clock = clock;
  }
  assertEnabled() { if (!this.enabled) throw Object.assign(new Error("memory maintenance is disabled"), { code: "MEMORY_MAINTENANCE_DISABLED" }); }
  previous() { return isSafeLocalPath(this.cwd, this.latestFile) ? readJson(this.latestFile, null) : null; }
  due(intervalHours, now = this.clock()) {
    const hours = Number(intervalHours || 0);
    if (!this.enabled || !Number.isFinite(hours) || hours <= 0) return { due: false, reason: "schedule-off", intervalHours: 0 };
    const prior = this.previous();
    const previousAt = Date.parse(prior?.generatedAt || 0);
    const current = new Date(now).getTime();
    const elapsedMs = Number.isFinite(previousAt) ? Math.max(0, current - previousAt) : Infinity;
    return { due: elapsedMs >= hours * 3600000, reason: elapsedMs >= hours * 3600000 ? "interval-elapsed" : "interval-pending", intervalHours: hours, previousAt: prior?.generatedAt || null, elapsedMs };
  }
  preview(options = {}) {
    this.assertEnabled();
    const started = Date.now();
    const now = new Date(options.now || this.clock());
    if (!Number.isFinite(now.getTime())) throw new Error("maintenance preview requires a valid time");
    const maxCandidates = Math.max(1, Math.min(5000, Number(options.maxCandidates || this.limits.maxCandidates)));
    const maxRecords = Math.max(1, Math.min(10000, Number(options.maxRecords || this.limits.maxRecords)));
    const maxDecisions = Math.max(1, Math.min(5000, Number(options.maxDecisions || this.limits.maxDecisions)));
    const maxEvidence = Math.max(1, Math.min(10000, Number(options.maxEvidence || this.limits.maxEvidence)));
    const maxElapsedMs = Math.max(50, Math.min(60000, Number(options.maxElapsedMs || this.limits.maxElapsedMs)));
    const rows = [];
    const providers = {};
    const unavailableProviders = [];
    let records = [];
    let knownRecordIds = new Set();
    let plan = { candidates: [], totalRecords: 0, truncated: false };
    let typedConflicts = [];

    try {
      const cognitiveFile = path.join(this.cwd, ".pi", "cognitive-automation", "cognitive-memory.json");
      if (!isSafeLocalPath(this.cwd, cognitiveFile)) throw Object.assign(new Error("unsafe typed-memory state path"), { code: "UNSAFE_STATE_PATH" });
      const allRecords = memoryStateCatalog.cognitiveEntries(this.cwd);
      knownRecordIds = new Set(allRecords.map((entry) => safeId(entry.id, "memory")));
      records = allRecords.slice(-maxRecords);
      plan = memoryStateCatalog.curationPlan(this.cwd, { limit: maxRecords, now: now.getTime() });
      typedConflicts = memoryStateCatalog.conflicts(this.cwd).slice(0, maxRecords);
      providers.typedMemory = { available: true, records: records.length, totalRecords: allRecords.length, truncated: allRecords.length > maxRecords, planTruncated: Boolean(plan.truncated), conflictCount: typedConflicts.length };
      for (const item of plan.candidates || []) {
        const category = item.action === "dedupe-review" || (item.reasons || []).some((reason) => /duplicate/i.test(String(reason))) ? "duplicate" : item.action === "forget-review" ? "stale" : "review";
        rows.push(candidate(category, item.recordId, item.action, item.reasons, { type: item.type, verification: item.verification, contentHash: item.contentHash }));
      }
      for (const item of typedConflicts) rows.push(candidate("conflict", item.recordId, "conflict-review", [item.verification === "contradicted" ? "contradicted" : "needs-review"], { contradicts: (item.contradicts || []).map((id) => safeId(id)).sort() }));
    } catch (error) {
      providers.typedMemory = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") };
      unavailableProviders.push("typed-memory");
    }

    let decisions = [];
    let decisionState = { reviewBacklog: 0, canonicalRevision: null, lastSuccessful: null };
    try {
      const decisionRoot = path.join(this.cwd, ".pi", "project-memory");
      if (![decisionRoot, path.join(decisionRoot, "decisions.jsonl"), path.join(decisionRoot, "state.json")].every((item) => isSafeLocalPath(this.cwd, item))) throw Object.assign(new Error("unsafe project-memory decision path"), { code: "UNSAFE_STATE_PATH" });
      const decisionStore = new ProjectMemoryDecisionStore({ cwd: this.cwd });
      decisions = decisionStore.list({ limit: maxDecisions }).map(publicDecision);
      decisionState = decisionStore.status();
      providers.projectMemoryDecisions = { available: true, decisions: decisions.length, truncated: decisionStore.list({ limit: maxDecisions + 1 }).length > maxDecisions, reviewBacklog: Number(decisionState.reviewBacklog || 0) };
      for (const item of decisions) if (item.action === "review-queued" || item.action === "rejected" || item.action === "superseded") rows.push(candidate(item.action === "superseded" ? "supersession" : item.action === "rejected" ? "rejected" : "canonical-review", item.decisionId, item.action, [item.reason], { candidateHash: item.candidateHash, noteRevision: item.noteRevision, verification: item.verification }));
    } catch (error) { providers.projectMemoryDecisions = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push("project-memory-decisions"); }

    let evidenceLedger = [];
    let evidenceIds = new Set();
    try {
      const evidenceRoot = path.join(this.cwd, ".pi", "evidence-binder");
      const evidenceLedgerFile = path.join(evidenceRoot, "evidence.jsonl");
      const packetDir = path.join(evidenceRoot, "packets");
      if (![evidenceRoot, evidenceLedgerFile, packetDir].every((item) => isSafeLocalPath(this.cwd, item))) throw Object.assign(new Error("unsafe evidence state path"), { code: "UNSAFE_STATE_PATH" });
      const allEvidenceLedger = readJsonl(evidenceLedgerFile);
      evidenceLedger = allEvidenceLedger.slice(-maxEvidence);
      evidenceIds = new Set(evidenceLedger.map((item) => safeId(item.id, "evidence")));
      const allEvidenceIds = new Set(allEvidenceLedger.map((item) => safeId(item.id, "evidence")));
      const allPacketNames = fs.existsSync(packetDir) ? fs.readdirSync(packetDir).filter((name) => /^[A-Za-z0-9._:-]+\.json$/.test(name)) : [];
      const packetNames = allPacketNames.slice(0, maxEvidence);
      const packetIds = new Set(packetNames.filter((name) => { try { const stat = fs.lstatSync(path.join(packetDir, name)); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } }).map((name) => safeId(name.slice(0, -5), "evidence")));
      const packetExists = (evidenceId) => { try { const stat = fs.lstatSync(path.join(packetDir, `${evidenceId}.json`)); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; } };
      const missingPackets = [...evidenceIds].filter((evidenceId) => !packetExists(evidenceId));
      const missingLedger = [...packetIds].filter((evidenceId) => !allEvidenceIds.has(evidenceId));
      for (const evidenceId of missingPackets) rows.push(candidate("evidence-consistency", evidenceId, "repair-evidence-packet", ["ledger-packet-missing"], { evidenceId }));
      for (const evidenceId of missingLedger) rows.push(candidate("evidence-consistency", evidenceId, "repair-evidence-ledger", ["packet-ledger-missing"], { evidenceId }));
      providers.evidenceIndex = { available: fs.existsSync(evidenceLedgerFile) || fs.existsSync(packetDir), records: evidenceLedger.length, packets: allPacketNames.length, mismatches: missingPackets.length + missingLedger.length, truncated: allEvidenceLedger.length > maxEvidence || allPacketNames.length > maxEvidence };
    } catch (error) { providers.evidenceIndex = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push("evidence-index"); }
    for (const entry of records) {
      const sourceId = safeId(entry.id, "memory");
      for (const evidenceId of (entry.evidenceIds || []).map((id) => safeId(id, "evidence"))) if (!evidenceIds.has(evidenceId)) rows.push(candidate("orphan-evidence", `${sourceId}:${evidenceId}`, "repair-reference", ["evidence-id-not-indexed"], { recordId: sourceId, evidenceId }));
      const backlinks = [...Object.values(entry.links || {}).flat(), ...(entry.supersedes || []), ...(entry.contradicts || [])].map((id) => safeId(id, "memory"));
      for (const targetId of backlinks) if (!knownRecordIds.has(targetId)) rows.push(candidate("orphan-backlink", `${sourceId}:${targetId}`, "repair-reference", ["target-record-missing"], { recordId: sourceId, targetId }));
    }

    if (!elapsedExceeded(started, maxElapsedMs)) {
      try {
        if (!retentionRoots(this.cwd).every((item) => isSafeLocalPath(this.cwd, item.root))) throw Object.assign(new Error("unsafe retention state path"), { code: "UNSAFE_STATE_PATH" });
        const retention = previewRetention({ cwd: this.cwd, ...(options.retention || {}), now: now.getTime() });
        providers.retention = { available: true, manifestId: retention.manifestId, complete: retention.complete, candidates: retention.candidates.length, classes: retention.classes };
        for (const item of retention.candidates || []) rows.push(candidate("retention", item.ref, "retention-review", item.reasons, { class: item.class, bytes: item.bytes, contentHash: item.contentHash, protected: item.protected }));
      } catch (error) { providers.retention = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push("retention"); }
    } else unavailableProviders.push("retention-time-budget");

    if (!elapsedExceeded(started, maxElapsedMs)) {
      try {
        const permissionOptions = { cwd: this.cwd, vault: null, home: path.join(this.root, "no-global-home") };
        if (!managedRoots(permissionOptions).every((item) => isSafeLocalPath(this.cwd, item.root))) throw Object.assign(new Error("unsafe permission state path"), { code: "UNSAFE_STATE_PATH" });
        const permissions = previewManagedPermissions(permissionOptions);
        providers.permissions = { available: true, manifestId: permissions.manifestId, complete: permissions.complete, files: { discovered: permissions.files.discovered, noncompliant: permissions.files.noncompliant }, directories: { discovered: permissions.directories.discovered, noncompliant: permissions.directories.noncompliant }, boundaries: permissions.boundaries };
        for (const item of permissions.files.candidates || []) rows.push(candidate("permission", item.ref, "permission-review", ["file-mode-noncompliant"], { class: item.class, currentMode: item.currentMode, desiredMode: item.desiredMode }));
        for (const item of permissions.directories.candidates || []) rows.push(candidate("permission", item.ref, "permission-review", ["directory-mode-noncompliant"], { class: item.class, currentMode: item.currentMode, desiredMode: item.desiredMode }));
      } catch (error) { providers.permissions = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push("permissions"); }
    } else unavailableProviders.push("permissions-time-budget");

    let candidateState = null;
    try {
      const candidateStateFile = path.join(this.cwd, ".pi", "project-memory", "candidate-state.json");
      if (!isSafeLocalPath(this.cwd, candidateStateFile)) throw Object.assign(new Error("unsafe candidate state path"), { code: "UNSAFE_STATE_PATH" });
      candidateState = readJson(candidateStateFile, null);
      const knownDecisionIds = new Set(decisions.map((item) => item.decisionId));
      const settleDecisionIds = (candidateState?.lastSettle?.decisions || []).map((item) => safeId(item.decisionId || "missing", "decision"));
      for (const decisionId of settleDecisionIds) if (!knownDecisionIds.has(decisionId)) rows.push(candidate("cache-consistency", decisionId, "inspect-source-decision", ["candidate-state-decision-missing"], { state: "candidate-state", decisionId }));
      const latestSuccessfulRevision = decisions.filter((item) => ["saved", "updated", "superseded"].includes(item.action) && item.noteRevision).at(-1)?.noteRevision || null;
      if (decisionState.canonicalRevision && latestSuccessfulRevision && decisionState.canonicalRevision !== latestSuccessfulRevision) rows.push(candidate("cache-consistency", "canonical-revision", "inspect-source-decision", ["canonical-revision-mismatch"], { stateRevision: decisionState.canonicalRevision, ledgerRevision: latestSuccessfulRevision }));
      providers.consistency = { available: true, candidateStateAvailable: Boolean(candidateState), settleDecisionRefs: settleDecisionIds.length, canonicalRevisionPresent: Boolean(decisionState.canonicalRevision), latestSuccessfulRevisionPresent: Boolean(latestSuccessfulRevision) };
    } catch (error) { providers.consistency = { available: false, errorCode: safeId(error?.code || error?.name || "provider-failed", "error") }; unavailableProviders.push("consistency"); }

    const selected = reportCandidateRows(rows, maxCandidates);
    const previous = this.previous();
    const previousIds = new Set((previous?.candidates || []).map((item) => item.candidateId));
    const currentIds = new Set(selected.candidates.map((item) => item.candidateId));
    const newlySeen = [...currentIds].filter((id) => !previousIds.has(id)).sort();
    const persistent = [...currentIds].filter((id) => previousIds.has(id)).sort();
    const resolved = [...previousIds].filter((id) => !currentIds.has(id)).sort().slice(0, this.limits.maxResolved);
    const sourceDecisionIdentity = {
      projectDecisionStateHash: `sha256:${digest({ canonicalRevision: decisionState.canonicalRevision || null, lastSuccessful: decisionState.lastSuccessful || null }, 64)}`,
      decisionLedgerHash: `sha256:${digest(decisions, 64)}`,
      evidenceIndexHash: `sha256:${digest(evidenceLedger.map((item) => ({ id: safeId(item.id, "evidence"), fingerprint: item.fingerprint || null, ok: item.ok === true })), 64)}`,
      candidateStateHash: candidateState ? `sha256:${digest({ seenFingerprints: candidateState.seenFingerprints || [], lastSettle: candidateState.lastSettle || null }, 64)}` : null,
    };
    const providerCompleteness = Object.values(providers).every((provider) => provider.available !== false && provider.complete !== false && provider.truncated !== true && provider.planTruncated !== true);
    const elapsedMs = Date.now() - started;
    const timeTruncated = elapsedMs > maxElapsedMs;
    const report = {
      schemaVersion: MEMORY_MAINTENANCE_SCHEMA_VERSION,
      reportId: `maintenance_${digest({ candidateIds: [...currentIds].sort(), sourceDecisionIdentity, providers }, 24)}`,
      generatedAt: now.toISOString(),
      preview: true,
      sourceDecisionIdentity,
      counts: selected.candidates.reduce((out, item) => (out[item.category] = (out[item.category] || 0) + 1, out), {}),
      candidateCount: selected.candidates.length,
      totalCandidateCount: selected.total,
      candidates: selected.candidates,
      accounting: { new: newlySeen, persistent, resolved, counts: { new: newlySeen.length, persistent: persistent.length, resolved: resolved.length, applied: null, ignored: null }, applied: { status: "insufficient-data", count: null }, ignored: { status: "insufficient-data", count: null } },
      stageMetrics: { durationMs: elapsedMs, modelCalls: 0, toolCalls: 0, contextAdded: 0 },
      coverage: { complete: providerCompleteness && !selected.truncated && !timeTruncated && unavailableProviders.length === 0, providers, unavailableProviders: [...new Set(unavailableProviders)].sort(), candidateTruncated: selected.truncated, timeTruncated, elapsedMs },
      boundaries: { rawSessionsRead: false, vaultBodiesRead: false, arbitraryHomeRead: false, repositoryScan: false, retentionApplied: false, permissionsApplied: false, memoryWritten: false, notesWritten: false, sourceDeleted: false, reportOnlyWrite: options.write !== false },
    };
    if (options.write !== false) {
      const stamp = report.generatedAt.replace(/[:.]/g, "-");
      const file = path.join(this.previewsRoot, `preview-${stamp}-${report.reportId}.json`);
      writePrivateJson(file, report);
      writePrivateJson(this.latestFile, report);
      appendPrivate(this.indexFile, { schemaVersion: 1, reportId: report.reportId, generatedAt: report.generatedAt, candidateCount: report.candidateCount, complete: report.coverage.complete, accounting: report.accounting.counts, stageMetrics: report.stageMetrics, fingerprint: `sha256:${digest(report, 64)}` });
      report.storage = { relativePath: path.relative(this.cwd, file).replace(/\\/g, "/"), private: true };
    }
    return report;
  }
  history({ limit = 100 } = {}) {
    if (!isSafeLocalPath(this.cwd, this.previewsRoot) || !fs.existsSync(this.previewsRoot)) return [];
    const names = fs.readdirSync(this.previewsRoot).filter((name) => /^preview-[A-Za-z0-9._-]+\.json$/.test(name)).sort().slice(-Math.max(1, Math.min(1000, Number(limit) || 100)));
    return names.flatMap((name) => { const file = path.join(this.previewsRoot, name); if (!isSafeLocalPath(this.cwd, file)) return []; const report = readJson(file, null); if (!report) return []; return [{ reportId: report.reportId, generatedAt: report.generatedAt, candidateIds: (report.candidates || []).map((item) => safeId(item.candidateId, "candidate")).slice(0, 5000), accounting: report.accounting, stageMetrics: report.stageMetrics || { durationMs: report.coverage?.elapsedMs || 0, modelCalls: 0, toolCalls: 0, contextAdded: 0 }, coverage: report.coverage, boundaries: report.boundaries }]; });
  }
  status() {
    const previous = this.previous();
    return { enabled: this.enabled, schemaVersion: MEMORY_MAINTENANCE_SCHEMA_VERSION, scheduleDefaultHours: 0, latest: previous ? { reportId: previous.reportId, generatedAt: previous.generatedAt, candidateCount: previous.candidateCount, complete: previous.coverage?.complete === true } : null, boundaries: { previewOnly: true, applyOperations: false } };
  }
}

module.exports = { MEMORY_MAINTENANCE_SCHEMA_VERSION, DEFAULT_LIMITS, MemoryMaintenanceAdapter, stableStringify, digest };
