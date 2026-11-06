"use strict";

// Evidence discovery returns opaque artifact references. Filesystem paths are
// resolved only in memory by trusted consumers and never enter durable proof
// packets or telemetry.

const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const KIND_BY_EXT = {
  ".png": "image", ".jpg": "image", ".jpeg": "image", ".webp": "image", ".gif": "image",
  ".mp4": "video", ".webm": "video", ".mov": "video",
  ".log": "log", ".txt": "log",
  ".data": "profile", ".perf": "profile", ".prof": "profile",
  ".jsonl": "trace",
};

const DEFAULT_SINCE_MINUTES = 240;
const MAX_ENTRIES = 25;
const MAX_FILES_PER_ROOT = 500;
const ARTIFACT_REF = /^artifact_[a-f0-9]{32}$/;

function digest(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }

function defaultRoots(cwd) {
  const configured = String(process.env.PI_EVIDENCE_ROOTS || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (configured.length) return configured;
  return [cwd, path.join(os.homedir(), "Pictures"), path.join(os.homedir(), "Pictures", "Screenshots"), path.join(os.homedir(), "Downloads")];
}

function classify(file) {
  const base = path.basename(file).toLowerCase();
  if (base === "perf.data" || base.startsWith("perf.data")) return "profile";
  if (base.endsWith(".visual-evidence.json") || base === "visual-evidence.json") return "visual-manifest";
  return KIND_BY_EXT[path.extname(base)] || null;
}

function artifactReference(root, name, stat) {
  return `artifact_${digest(`${digest(path.resolve(root))}:${name}:${stat.size}:${Math.floor(stat.mtimeMs)}`).slice(0, 32)}`;
}

function scanRoot(root, cutoffMs, entries, internal = false) {
  let names = [];
  try { names = fs.readdirSync(root).slice(0, MAX_FILES_PER_ROOT); }
  catch { return; }
  for (const name of names) {
    const file = path.join(root, name);
    const kind = classify(file);
    if (!kind) continue;
    try {
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.mtimeMs < cutoffMs) continue;
      const entry = {
        artifactRef: artifactReference(root, name, stat),
        displayName: path.basename(name).slice(0, 160),
        kind,
        bytes: stat.size,
        modifiedAt: new Date(stat.mtimeMs).toISOString(),
        mtimeMs: stat.mtimeMs,
      };
      entries.push(internal ? { ...entry, file: path.resolve(file), root: path.resolve(root) } : entry);
    } catch {}
  }
}

function normalizedRoots(cwd, options = {}) {
  return Array.from(new Set((options.roots?.length ? options.roots : defaultRoots(cwd)).map((root) => path.resolve(cwd, root))));
}

function scanEvidence(cwd = process.cwd(), options = {}) {
  const sinceMinutes = Number(options.sinceMinutes) > 0 ? Number(options.sinceMinutes) : DEFAULT_SINCE_MINUTES;
  const cutoffMs = Date.now() - sinceMinutes * 60_000;
  const roots = normalizedRoots(cwd, options);
  const entries = [];
  for (const root of roots) scanRoot(root, cutoffMs, entries, false);
  const kinds = options.kinds?.length ? new Set(options.kinds) : null;
  const filtered = entries
    .filter((entry) => !kinds || kinds.has(entry.kind))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, Math.max(1, Math.min(100, Number(options.limit) || MAX_ENTRIES)))
    .map(({ mtimeMs, displayName, ...entry }) => entry);
  return { generatedAt: new Date().toISOString(), sinceMinutes, rootCount: roots.length, entries: filtered };
}

function resolveEvidenceArtifact(cwd = process.cwd(), artifactRef, options = {}) {
  if (!ARTIFACT_REF.test(String(artifactRef || ""))) return null;
  const roots = normalizedRoots(cwd, options);
  const entries = [];
  const sinceMinutes = Number(options.sinceMinutes) > 0 ? Number(options.sinceMinutes) : 365 * 24 * 60;
  const cutoffMs = Date.now() - sinceMinutes * 60_000;
  for (const root of roots) scanRoot(root, cutoffMs, entries, true);
  const match = entries.find((entry) => entry.artifactRef === artifactRef);
  if (!match) return null;
  try {
    const realRoot = fs.realpathSync(match.root);
    const realFile = fs.realpathSync(match.file);
    if (realFile !== realRoot && !realFile.startsWith(`${realRoot}${path.sep}`)) return null;
    const stat = fs.lstatSync(realFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    return { ...match, file: realFile };
  } catch { return null; }
}

function formatEvidence(result) {
  if (!result.entries.length) return `No recent evidence artifacts (last ${result.sinceMinutes} min; ${result.rootCount} configured roots)`;
  return result.entries
    .map((entry) => `${entry.modifiedAt} [${entry.kind}] ${entry.artifactRef} (${entry.bytes} bytes)`)
    .join("\n");
}

module.exports = { scanEvidence, resolveEvidenceArtifact, formatEvidence, classify, ARTIFACT_REF };
