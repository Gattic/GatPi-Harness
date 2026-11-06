"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { inventoryState } = require("./state-inventory");
const { sha256 } = require("./project-memory-schema");
function managedRoots({ cwd = process.cwd(), vault } = {}) { return [
  { class: "cognitive", root: path.join(cwd, ".pi", "cognitive-automation") },
  { class: "verification", root: path.join(cwd, ".pi", "verification-center") },
  { class: "learning", root: path.join(cwd, ".pi", "learning-loop") },
  { class: "debug", root: path.join(cwd, ".pi", "debug-ledger") },
  { class: "trace", root: path.join(cwd, ".pi", "traces") },
  { class: "project-memory", root: path.join(cwd, ".pi", "project-memory") },
  { class: "hermes-advisory", root: path.join(cwd, ".pi", "hermes-advisory") },
  { class: "hermes-skill-quarantine", root: path.join(cwd, ".pi", "hermes-skill-candidates") },
  { class: "obsidian-metadata", root: path.join(cwd, ".pi", "obsidian") },
  { class: "managed-vault-memory", root: vault ? path.join(vault, "Memory", "Projects") : null },
].filter((row) => row.root && fs.existsSync(row.root)); }
function walkDirectories(root) { const out = []; function walk(dir) { let stat; try { stat = fs.lstatSync(dir); } catch { return; } if (stat.isSymbolicLink() || !stat.isDirectory()) return; out.push({ path: dir, mode: stat.mode & 0o777 }); for (const name of fs.readdirSync(dir).sort()) { const item = path.join(dir, name); try { const child = fs.lstatSync(item); if (child.isDirectory() && !child.isSymbolicLink()) walk(item); } catch {} } } walk(root); return out; }
function buildPermissionPreview(options = {}) {
  const roots = managedRoots(options); const files = []; const directories = []; const skipped = []; const errors = [];
  for (const source of roots) { const inventory = inventoryState([source.root]); for (const file of inventory.files) files.push({ _path: file.path, ref: `mode_${sha256(file.path).slice(0, 20)}`, class: source.class, currentMode: file.mode, desiredMode: 0o600, compliant: file.mode === 0o600 }); for (const row of walkDirectories(source.root)) directories.push({ _path: row.path, ref: `mode_${sha256(row.path).slice(0, 20)}`, class: source.class, currentMode: row.mode, desiredMode: 0o700, compliant: row.mode === 0o700 }); skipped.push(...inventory.skippedEntries.map((row) => ({ class: source.class, reason: row.reason }))); errors.push(...inventory.errors.map((row) => ({ class: source.class, reason: row.reason, code: row.code }))); }
  const publicRows = (rows) => rows.map(({ _path, ...row }) => row); const identity = [...files, ...directories].map(({ ref, currentMode, desiredMode }) => ({ ref, currentMode, desiredMode })); const manifestId = `permissions_${sha256(JSON.stringify(identity)).slice(0, 16)}`;
  return { schemaVersion: 1, manifestId, preview: true, roots: roots.map((row) => ({ class: row.class })), files: { discovered: files.length, noncompliant: files.filter((row) => !row.compliant).length, candidates: publicRows(files.filter((row) => !row.compliant)) }, directories: { discovered: directories.length, noncompliant: directories.filter((row) => !row.compliant).length, candidates: publicRows(directories.filter((row) => !row.compliant)) }, skippedReasons: skipped.reduce((out, row) => (out[row.reason] = (out[row.reason] || 0) + 1, out), {}), errors, complete: errors.length === 0, boundaries: { entireVaultInScope: false, researchNotesInScope: false }, _private: { files, directories } };
}
function previewManagedPermissions(options = {}) { const { _private, ...safe } = buildPermissionPreview(options); return safe; }
function applyManagedPermissions(options = {}) { const preview = buildPermissionPreview(options); if (options.apply && !options.manifestId) return { ok: false, outcome: "blocked", reason: "permission-preview-manifest-required", expectedManifestId: preview.manifestId }; if (options.manifestId && options.manifestId !== preview.manifestId) return { ok: false, outcome: "blocked", reason: "permission-input-drift", expectedManifestId: preview.manifestId }; if (!options.apply) { const { _private, ...safe } = preview; return { ...safe, outcome: "preview" }; } let changedFiles = 0; let changedDirectories = 0; const errors = []; for (const row of preview._private.files.filter((item) => !item.compliant)) { try { const stat = fs.lstatSync(row._path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("unsafe-file"); fs.chmodSync(row._path, 0o600); changedFiles++; } catch (error) { errors.push({ ref: row.ref, class: row.class, reason: error?.message || "chmod-file" }); } } for (const row of preview._private.directories.filter((item) => !item.compliant)) { try { const stat = fs.lstatSync(row._path); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("unsafe-directory"); fs.chmodSync(row._path, 0o700); changedDirectories++; } catch (error) { errors.push({ ref: row.ref, class: row.class, reason: error?.message || "chmod-directory" }); } } return { ok: errors.length === 0, outcome: "applied", manifestId: preview.manifestId, changedFiles, changedDirectories, errors, boundaries: preview.boundaries };
}
module.exports = { managedRoots, previewManagedPermissions, applyManagedPermissions };
