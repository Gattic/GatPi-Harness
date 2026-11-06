"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const DEFAULT_SCORECARD_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SOURCE_NAME_PATTERN = /^(?:project-memory|memory-effectiveness|memory-state|state-inventory|state-retention|managed-state|session-storage|cognitive-memory|fix-recall|integration-boundary|obsidian-adapter|hermes-advisory|hermes-integration-scorecard)/;

function sourceFiles(implementationRoot = path.resolve(__dirname, "..")) {
  const root = path.resolve(implementationRoot);
  const srcDir = path.join(root, "src");
  const src = fs.readdirSync(srcDir).filter((name) => SOURCE_NAME_PATTERN.test(name)).sort().map((name) => path.join(srcDir, name));
  return [
    path.join(root, "tests", "fixtures", "memory-effectiveness", "manifest.json"),
    path.join(root, "scripts", "report-memory-effectiveness.js"),
    path.join(root, "scripts", "report-privacy-rollout-evidence.mjs"),
    path.join(root, "scripts", "review-privacy-rollout-evidence.js"),
    path.join(root, "scripts", "report-reviewed-gold-evidence.js"),
    path.join(root, "scripts", "review-reviewed-gold-evidence.js"),
    path.join(root, "scripts", "benchmark-project-memory.js"),
    path.join(root, "src", "privacy-guard-scan.js"),
    ...src,
    path.join(root, ".pi", "extensions", "privacy-guard", "index.ts"),
    path.join(root, ".pi", "extensions", "memory-explorer", "index.ts"),
    path.join(root, ".pi", "extensions", "reasoning-runtime", "index.ts"),
    path.join(root, ".pi", "extensions", "obsidian", "index.ts"),
    path.join(root, "extensions", "hermes-advisory", "index.ts"),
  ];
}
function hashFiles(implementationRoot, files = sourceFiles(implementationRoot)) {
  const root = path.resolve(implementationRoot || path.resolve(__dirname, ".."));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(path.relative(root, file));
    try { hash.update(fs.readFileSync(file)); }
    catch (error) { hash.update(`missing:${error?.code || "UNKNOWN"}`); }
  }
  return `sha256:${hash.digest("hex")}`;
}
function currentMemorySourceEvidence({ implementationRoot = path.resolve(__dirname, "..") } = {}) {
  const root = path.resolve(implementationRoot);
  const configHash = hashFiles(root);
  return { revision: `content:${configHash.slice(7)}`, configHash };
}
function validateScorecardSource(scorecard = {}, current = currentMemorySourceEvidence(), { now = Date.now(), maxAgeMs = DEFAULT_SCORECARD_MAX_AGE_MS } = {}) {
  const reasons = [];
  if (scorecard.schemaVersion !== 1) reasons.push("missing-or-invalid-scorecard");
  if (!scorecard.source || scorecard.source.revision !== current.revision) reasons.push("source-revision-mismatch");
  if (!scorecard.source || scorecard.source.configHash !== current.configHash) reasons.push("config-hash-mismatch");
  const generatedMs = Date.parse(String(scorecard.generatedAt || ""));
  if (!Number.isFinite(generatedMs)) reasons.push("missing-generated-at");
  else if (Number.isFinite(maxAgeMs) && maxAgeMs >= 0 && now - generatedMs > maxAgeMs) reasons.push("scorecard-expired");
  else if (generatedMs > now + 5 * 60 * 1000) reasons.push("scorecard-from-future");
  return { ok: reasons.length === 0, reasons, checkedAt: new Date(now).toISOString(), maxAgeMs, current };
}

module.exports = { DEFAULT_SCORECARD_MAX_AGE_MS, SOURCE_NAME_PATTERN, sourceFiles, hashFiles, currentMemorySourceEvidence, validateScorecardSource };
