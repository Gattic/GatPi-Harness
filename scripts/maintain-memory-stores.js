#!/usr/bin/env node
"use strict";

// Bounds the two append-only cognitive stores that grow without a retention
// owner: cognitive-memory.json (duplicate collapse plus per-type caps) and
// reasoning-runtime.json (automated verifier evidence and executor actions).
// Dry run by default; --apply backs up both files privately before rewriting.
// Canonical project memory in the Obsidian vault is never touched, and the
// stores are only rewritten when no running Pi process owns them.

const fs = require("node:fs");
const path = require("node:path");
const { CognitiveMemory } = require("../src/cognitive-memory");
const { ReasoningRuntime, AUTOMATED_RETENTION, retentionBound } = require("../src/reasoning-runtime");
const { FileIntegrationStorage } = require("../src/file-integration-storage");
const { writePrivateJson } = require("../src/project-memory-decisions");

const args = process.argv.slice(2);
if (args.some((arg) => arg !== "--apply")) throw new Error("usage: node scripts/maintain-memory-stores.js [--apply]");
const apply = args.includes("--apply");
const cwd = process.cwd();
const storeRoot = path.join(cwd, ".pi", "cognitive-automation");
const memoryFile = path.join(storeRoot, "cognitive-memory.json");
const reasoningFile = path.join(storeRoot, "reasoning-runtime.json");
const receiptFile = path.join(cwd, ".pi", "memory-maintenance", "latest.json");
const backupRoot = path.join(cwd, ".pi", "memory-maintenance", "backups", new Date().toISOString().replace(/[:.]/g, "-"));
const keep = {
  evidence: retentionBound(process.env.PI_REASONING_AUTO_PRUNE_AUTOMATED_KEEP || AUTOMATED_RETENTION.evidence, AUTOMATED_RETENTION.evidence),
  executorActions: retentionBound(process.env.PI_REASONING_AUTO_PRUNE_ACTIONS_KEEP || AUTOMATED_RETENTION.executorActions, AUTOMATED_RETENTION.executorActions),
};

function backup(file) {
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const target = path.join(backupRoot, path.basename(file));
  fs.copyFileSync(file, target);
  fs.chmodSync(target, 0o600);
  const sourceBytes = fs.lstatSync(file).size;
  const backupBytes = fs.lstatSync(target).size;
  if (sourceBytes !== backupBytes) throw new Error(`backup size mismatch for ${path.basename(file)}`);
  return { file: path.relative(cwd, target).replace(/\\/g, "/"), bytes: backupBytes };
}

function typeCounts(metrics) {
  return Object.fromEntries(Object.entries(metrics.byType).map(([type, row]) => [type, row.entries]));
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  apply,
  storeRoot: path.relative(cwd, storeRoot).replace(/\\/g, "/"),
  cognitiveMemory: { present: fs.existsSync(memoryFile) },
  reasoningRuntime: { present: fs.existsSync(reasoningFile) },
  canonicalMemoryTouched: false,
  sessionFilesTouched: false,
};

if (report.cognitiveMemory.present) {
  const memory = CognitiveMemory.load(memoryFile);
  const before = memory.metrics();
  const deduplicated = memory.dedupeExact();
  const pruned = memory.boundByCount();
  const after = memory.metrics();
  Object.assign(report.cognitiveMemory, {
    beforeEntries: before.totalEntries,
    afterEntries: after.totalEntries,
    byTypeBefore: typeCounts(before),
    byTypeAfter: typeCounts(after),
    deduplicated: deduplicated.length,
    countPruned: pruned.length,
  });
  if (apply) {
    report.cognitiveMemory.backup = backup(memoryFile);
    memory.save(memoryFile);
    report.cognitiveMemory.written = true;
  }
}

if (report.reasoningRuntime.present) {
  const storage = new FileIntegrationStorage(storeRoot);
  const runtime = new ReasoningRuntime({ storage });
  const before = runtime.metrics();
  const preview = runtime.pruneAutomatedVerification({ keep: keep.evidence, keepExecutorActions: keep.executorActions, dryRun: true });
  Object.assign(report.reasoningRuntime, {
    artifactsBefore: before.artifacts,
    automatedVerifierEvidence: before.automatedVerifierEvidence,
    automatedExecutorActions: before.automatedExecutorActions,
    keep,
    removeCandidates: preview.removed.length,
    artifactsAfter: before.artifacts - preview.removed.length,
  });
  if (apply) {
    report.reasoningRuntime.backup = backup(reasoningFile);
    runtime.pruneAutomatedVerification({ keep: keep.evidence, keepExecutorActions: keep.executorActions, dryRun: false });
    runtime.persist();
    report.reasoningRuntime.written = true;
    report.reasoningRuntime.artifactsAfter = runtime.metrics().artifacts;
  }
}

if (apply) writePrivateJson(receiptFile, report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
