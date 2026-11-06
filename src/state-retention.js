"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inventoryState } = require("./state-inventory");
const { sha256 } = require("./project-memory-schema");
const { ensurePrivateDir, writePrivateJson } = require("./project-memory-decisions");

const MB = 1024 * 1024;
const RETENTION_POLICIES = Object.freeze({
  trace: { maxFiles: 200, maxAgeDays: 14, maxBytes: 24 * MB },
  entropy: { maxFiles: 120, maxAgeDays: 14, maxBytes: 8 * MB },
  snapshot: { maxFiles: 80, maxAgeDays: 30, maxBytes: 16 * MB },
  verification: { maxFiles: 120, maxAgeDays: 30, maxBytes: 16 * MB },
  run: { maxFiles: 100, maxAgeDays: 30, maxBytes: 16 * MB },
  reasoning: { maxFiles: 400, maxAgeDays: 14, maxBytes: 48 * MB },
  subagents: { maxFiles: 200, maxAgeDays: 7, maxBytes: 128 * MB },
  // Authored planning/evidence artifacts and pinned toolchains are reported but
  // never deletion candidates. They are historical evidence or installed
  // runtimes, not disposable caches.
  planning: { maxFiles: 5000, maxAgeDays: 365, maxBytes: 64 * MB, reportOnly: true },
  evidence: { maxFiles: 2000, maxAgeDays: 365, maxBytes: 64 * MB, reportOnly: true },
  "toolchain-cache": { maxFiles: 5000, maxAgeDays: 30, maxBytes: 256 * MB },
  "toolchain-install": { maxFiles: 10000, maxAgeDays: 3650, maxBytes: 2048 * MB, reportOnly: true },
});
function rootsFor(cwd) { return [
  { class: "trace", root: path.join(cwd, ".pi", "traces") },
  { class: "trace", root: path.join(cwd, ".pi", "cognitive-automation", "trace") },
  { class: "entropy", root: path.join(cwd, ".pi", "cognitive-automation", "entropy") },
  { class: "snapshot", root: path.join(cwd, ".pi", "cognitive-automation", "snapshots") },
  { class: "snapshot", root: path.join(cwd, ".pi", "cognitive-automation", "reasoning", "snapshots") },
  { class: "snapshot", root: path.join(cwd, ".pi", "session-branches", "snapshots") },
  { class: "verification", root: path.join(cwd, ".pi", "verification-center") },
  { class: "run", root: path.join(cwd, ".pi", "topology-runs") },
  { class: "reasoning", root: path.join(cwd, ".pi", "cognitive-automation", "reasoning"), includeFile: (file) => !file.startsWith(`${path.join(cwd, ".pi", "cognitive-automation", "reasoning", "snapshots")}${path.sep}`) },
  { class: "subagents", root: path.join(cwd, ".pi", "subagents", "rpc-sessions") },
  { class: "subagents", root: path.join(cwd, ".pi", "subagents", "workspaces") },
  { class: "planning", root: path.join(cwd, ".pi", "planning") },
  { class: "evidence", root: path.join(cwd, ".pi", "evidence-binder") },
  { class: "toolchain-cache", root: path.join(cwd, ".pi", "toolchains", "npm-cache") },
  { class: "toolchain-install", root: path.join(cwd, ".pi", "toolchains"), includeFile: (file) => !file.startsWith(`${path.join(cwd, ".pi", "toolchains", "npm-cache")}${path.sep}`) },
].filter((row) => fs.existsSync(row.root)); }
function readProtectedRefs(cwd) {
  const refs = readDebugProtected(cwd);
  const workspaces = path.join(cwd, ".pi", "subagents", "workspaces");
  if (!fs.existsSync(workspaces)) return refs;
  for (const name of fs.readdirSync(workspaces)) {
    const dir = path.join(workspaces, name);
    try { if (!fs.statSync(dir).isDirectory()) continue; } catch { continue; }
    let lease = null;
    try { lease = JSON.parse(fs.readFileSync(path.join(dir, "lease.json"), "utf8")); } catch {}
    if (lease?.state === "active") refs.add(path.relative(cwd, dir).replace(/\\/g, "/"));
  }
  return refs;
}
function readDebugProtected(cwd) {
  const root = path.join(cwd, ".pi", "debug-ledger"); const refs = new Set(); if (!fs.existsSync(root)) return refs;
  for (const file of inventoryState([root], { includeFile: (name) => name.endsWith(".json") }).files) {
    try { const data = JSON.parse(fs.readFileSync(file.path, "utf8")); for (const attempt of data.attempts || []) for (const evidence of attempt.evidence || []) refs.add(String(evidence).replace(/\\/g, "/")); } catch {}
  }
  return refs;
}
function protectedFile(cwd, file, refs, explicit = []) { const relative = path.relative(cwd, file).replace(/\\/g, "/"); return [...refs, ...explicit].some((ref) => relative === ref || relative.startsWith(`${ref}/`) || relative.endsWith(`/${ref}`) || ref.endsWith(`/${relative}`) || path.basename(relative) === path.basename(ref)); }
function selectClass(cwd, className, files, policy, now, refs, explicitProtected) {
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs || a.path.localeCompare(b.path)); let retainedBytes = 0; const rows = [];
  for (let index = 0; index < sorted.length; index++) {
    const file = sorted[index]; const ageDays = Math.max(0, (now - file.mtimeMs) / 86400000); const protectedByLineage = protectedFile(cwd, file.path, refs, explicitProtected); const reasons = [];
    if (index >= policy.maxFiles) reasons.push("count-limit");
    if (ageDays > policy.maxAgeDays) reasons.push("age-limit");
    if (retainedBytes + file.bytes > policy.maxBytes) reasons.push("byte-limit");
    const candidate = reasons.length > 0 && !protectedByLineage && !policy.reportOnly;
    if (!candidate) retainedBytes += file.bytes;
    rows.push({ _path: file.path, ref: `ret_${sha256(file.path).slice(0, 20)}`, class: className, bytes: file.bytes, contentHash: `sha256:${fileHash(file.path)}`, ageDays: Number(ageDays.toFixed(2)), reasons, protected: protectedByLineage, candidate });
  }
  return rows;
}
function fileHash(file) { const hash = require("node:crypto").createHash("sha256"); const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); try { const buffer = Buffer.allocUnsafe(1024 * 1024); while (true) { const size = fs.readSync(fd, buffer, 0, buffer.length, null); if (!size) break; hash.update(buffer.subarray(0, size)); } return hash.digest("hex"); } finally { fs.closeSync(fd); } }
function publicRow(row) { const { _path, ...result } = row; return result; }
function previewRetention({ cwd = process.cwd(), policies = RETENTION_POLICIES, protectedRefs = [], now = Date.now() } = {}) {
  const refs = readProtectedRefs(cwd); const grouped = new Map(); const coverage = [];
  for (const source of rootsFor(cwd)) { const inventory = inventoryState([source.root], source.includeFile ? { includeFile: source.includeFile } : {}); coverage.push({ class: source.class, complete: inventory.summary.complete, files: inventory.summary.discoveredFiles, bytes: inventory.summary.discoveredBytes }); const values = grouped.get(source.class) || []; values.push(...inventory.files); grouped.set(source.class, values); }
  const rows = []; for (const [className, files] of grouped) rows.push(...selectClass(cwd, className, files, policies[className] || RETENTION_POLICIES[className], now, refs, protectedRefs));
  const candidates = rows.filter((row) => row.candidate); const safeRows = rows.map(publicRow); const identityRows = safeRows.map(({ ageDays, reasons, ...row }) => row); const manifestId = `retention_${sha256(JSON.stringify(identityRows)).slice(0, 16)}`;
  const footprint = Object.fromEntries([...grouped.keys()].map((className) => {
    const selected = rows.filter((row) => row.class === className);
    const policy = policies[className] || RETENTION_POLICIES[className];
    const bytes = selected.reduce((sum, row) => sum + row.bytes, 0);
    return [className, { files: selected.length, bytes, maxFiles: policy.maxFiles, maxBytes: policy.maxBytes, maxAgeDays: policy.maxAgeDays, reportOnly: Boolean(policy.reportOnly), overFileCap: selected.length > policy.maxFiles, overByteCap: bytes > policy.maxBytes, reclaimableBytes: selected.filter((row) => row.candidate).reduce((sum, row) => sum + row.bytes, 0) }];
  }));
  const totalBytes = coverage.reduce((sum, row) => sum + row.bytes, 0);
  return { schemaVersion: 1, manifestId, generatedAt: new Date(now).toISOString(), preview: true, policies, coverage, footprint: { totalBytes, classes: footprint }, classes: Object.fromEntries([...grouped.keys()].map((className) => { const selected = rows.filter((row) => row.class === className); return [className, { files: selected.length, bytes: selected.reduce((sum, row) => sum + row.bytes, 0), candidates: selected.filter((row) => row.candidate).length, candidateBytes: selected.filter((row) => row.candidate).reduce((sum, row) => sum + row.bytes, 0), protected: selected.filter((row) => row.protected).length, reportOnly: Boolean((policies[className] || RETENTION_POLICIES[className]).reportOnly) }]; })), candidates: candidates.map(publicRow), complete: coverage.every((row) => row.complete), boundaries: { rawSessionsInScope: false, canonicalMemoryInScope: false, deletionPerformed: false } };
}
function copyPrivate(source, target) { ensurePrivateDir(path.dirname(target)); const input = fs.openSync(source, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0)); const output = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0), 0o600); try { fs.fchmodSync(output, 0o600); const buffer = Buffer.allocUnsafe(1024 * 1024); while (true) { const size = fs.readSync(input, buffer, 0, buffer.length, null); if (!size) break; fs.writeSync(output, buffer.subarray(0, size)); } fs.fsyncSync(output); } finally { fs.closeSync(input); fs.closeSync(output); } }
function rediscover(cwd) { const all = []; for (const source of rootsFor(cwd)) for (const file of inventoryState([source.root]).files) all.push({ ref: `ret_${sha256(file.path).slice(0, 20)}`, path: file.path, hash: `sha256:${fileHash(file.path)}` }); return new Map(all.map((row) => [row.ref, row])); }
function applyRetention({ cwd = process.cwd(), manifestId, className, apply = false, policies = RETENTION_POLICIES, protectedRefs = [] } = {}) {
  const preview = previewRetention({ cwd, policies, protectedRefs }); if (apply && !manifestId) return { ok: false, outcome: "blocked", reason: "retention-preview-manifest-required", expectedManifestId: preview.manifestId }; if (manifestId && manifestId !== preview.manifestId) return { ok: false, outcome: "blocked", reason: "retention-input-drift", expectedManifestId: preview.manifestId };
  const selected = preview.candidates.filter((row) => !className || row.class === className); if (!apply) return { ok: true, outcome: "preview", manifestId: preview.manifestId, selected: selected.length, bytes: selected.reduce((sum, row) => sum + row.bytes, 0) };
  if (!className) return { ok: false, outcome: "blocked", reason: "one-retention-class-required" };
  const policy = policies[className] || RETENTION_POLICIES[className];
  if (!policy) return { ok: false, outcome: "blocked", reason: "one-retention-class-required" };
  if (policy.reportOnly) return { ok: false, outcome: "blocked", reason: "report-only-retention-class" };
  const discovered = rediscover(cwd); const stateDir = path.join(cwd, ".pi", "retention", preview.manifestId); const backupDir = path.join(stateDir, "backups"); ensurePrivateDir(backupDir); const operations = [];
  for (const candidate of selected) { const source = discovered.get(candidate.ref); if (!source || source.hash !== candidate.contentHash) { operations.push({ ref: candidate.ref, outcome: "blocked", reason: "source-drift" }); continue; } const backup = path.join(backupDir, candidate.ref); copyPrivate(source.path, backup); fs.rmSync(source.path); operations.push({ ref: candidate.ref, outcome: "archived-private", class: candidate.class, bytes: candidate.bytes, contentHash: candidate.contentHash, backup: candidate.ref, originalPath: source.path }); }
  const state = { schemaVersion: 1, manifestId: preview.manifestId, className, status: "applied", at: new Date().toISOString(), operations }; writePrivateJson(path.join(stateDir, "state.json"), state);
  return { ok: operations.every((row) => row.outcome === "archived-private"), outcome: "applied", manifestId: preview.manifestId, className, operations: operations.map(({ originalPath, backup, ...row }) => row) };
}
function rollbackRetention({ cwd = process.cwd(), manifestId, apply = false } = {}) {
  const stateDir = path.join(cwd, ".pi", "retention", String(manifestId || "")); const file = path.join(stateDir, "state.json"); const state = JSON.parse(fs.readFileSync(file, "utf8")); const rows = [];
  for (const operation of state.operations || []) { if (operation.outcome !== "archived-private") continue; const backup = path.join(stateDir, "backups", operation.backup); const safe = fs.existsSync(backup) && `sha256:${fileHash(backup)}` === operation.contentHash && !fs.existsSync(operation.originalPath); rows.push({ ref: operation.ref, safe }); if (apply && safe) { ensurePrivateDir(path.dirname(operation.originalPath)); fs.renameSync(backup, operation.originalPath); fs.chmodSync(operation.originalPath, 0o600); } }
  if (apply && rows.every((row) => row.safe)) { state.status = "rolled-back"; state.rolledBackAt = new Date().toISOString(); writePrivateJson(file, state); }
  return { ok: rows.every((row) => row.safe), outcome: apply ? (rows.every((row) => row.safe) ? "rolled-back" : "blocked") : "rollback-preview", manifestId, operations: rows };
}
module.exports = { RETENTION_POLICIES, rootsFor, previewRetention, applyRetention, rollbackRetention, readDebugProtected, readProtectedRefs };
