"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MemoryMaintenanceAdapter } = require("../src/memory-maintenance");
const { ProjectMemoryDecisionStore } = require("../src/project-memory-decisions");
const { RETENTION_POLICIES } = require("../src/state-retention");
const { tmpFixture } = require("./helpers/tmp-fixture");

function treeState(root, exclude = () => false) {
  const rows = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      if (exclude(file)) continue;
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else rows.push({ relative: path.relative(root, file), bytes: fs.readFileSync(file).toString("hex"), mode: stat.mode & 0o777 });
    }
  }
  walk(root);
  return rows;
}

const cwd = tmpFixture("memory-maintenance-");
const cognitive = path.join(cwd, ".pi", "cognitive-automation");
fs.mkdirSync(cognitive, { recursive: true, mode: 0o755 });
fs.chmodSync(cognitive, 0o755);
const sentinel = "PRIVATE_SOURCE_BODY_MUST_NOT_ENTER_REPORT";
const entries = [
  { id: "memory-a", type: "semantic", title: "A", content: `${sentinel} stable fact`, tags: ["decision"], verification: "verified", provenance: { source: "explicit" }, evidenceIds: ["evidence-present", "evidence-missing"], links: { related: ["memory-missing"] } },
  { id: "memory-duplicate", type: "semantic", title: "Duplicate", content: `${sentinel} stable fact`, tags: ["decision"], verification: "verified", provenance: { source: "explicit" } },
  { id: "memory-expired", type: "semantic", title: "Expired", content: "expired fact", tags: ["decision"], verification: "verified", expiresAt: "2020-01-01T00:00:00.000Z", provenance: { source: "explicit" } },
  { id: "memory-conflict", type: "semantic", title: "Conflict", content: "contradicted fact", tags: ["decision"], verification: "contradicted", contradicts: ["memory-a"], provenance: { source: "explicit" } },
];
const memoryFile = path.join(cognitive, "cognitive-memory.json");
fs.writeFileSync(memoryFile, JSON.stringify({ entries }), { mode: 0o644 });
fs.chmodSync(memoryFile, 0o644);
const evidenceRoot = path.join(cwd, ".pi", "evidence-binder");
fs.mkdirSync(evidenceRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(evidenceRoot, 0o700);
fs.writeFileSync(path.join(evidenceRoot, "evidence.jsonl"), `${JSON.stringify({ id: "evidence-present", fingerprint: "fingerprint-1", ok: true })}\n`, { mode: 0o600 });
fs.chmodSync(path.join(evidenceRoot, "evidence.jsonl"), 0o600);
const traceRoot = path.join(cwd, ".pi", "traces");
fs.mkdirSync(traceRoot, { recursive: true, mode: 0o700 });
fs.chmodSync(traceRoot, 0o700);
for (let index = 0; index < 3; index++) { const traceFile = path.join(traceRoot, `trace-${index}.jsonl`); fs.writeFileSync(traceFile, `${index}\n`, { mode: 0o600 }); fs.chmodSync(traceFile, 0o600); }
const decisions = new ProjectMemoryDecisionStore({ cwd, clock: () => new Date("2026-07-31T00:00:00.000Z") });
decisions.record({ projectKey: "pi:test", kind: "decision", action: "review-queued", reason: "PRIVATE_DECISION_REASON", candidateHash: `sha256:${"a".repeat(64)}`, verification: "unverified" });
decisions.record({ projectKey: "pi:test", kind: "decision", action: "superseded", reason: "conflict", candidateHash: `sha256:${"2".repeat(64)}`, noteRevision: "3".repeat(64), verification: "verified" });
fs.writeFileSync(path.join(cwd, ".pi", "project-memory", "candidate-state.json"), JSON.stringify({ lastSettle: { decisions: [{ decisionId: "decision-not-in-ledger" }] }, seenFingerprints: [] }), { mode: 0o600 });
fs.chmodSync(path.join(cwd, ".pi", "project-memory", "candidate-state.json"), 0o600);

const maintenanceRoot = path.join(cwd, ".pi", "memory-maintenance");
const before = treeState(path.join(cwd, ".pi"), (file) => file.startsWith(maintenanceRoot));
const adapter = new MemoryMaintenanceAdapter({ cwd, clock: () => new Date("2026-07-31T12:00:00.000Z") });
const options = { now: "2026-07-31T12:00:00.000Z", retention: { policies: { ...RETENTION_POLICIES, trace: { maxFiles: 1, maxAgeDays: 9999, maxBytes: 1024 } } } };
const first = adapter.preview(options);
assert.equal(first.preview, true);
assert.equal(first.boundaries.retentionApplied, false);
assert.equal(first.boundaries.permissionsApplied, false);
assert.equal(first.boundaries.memoryWritten, false);
assert.equal(first.boundaries.rawSessionsRead, false);
assert.equal(first.sourceDecisionIdentity.decisionLedgerHash.startsWith("sha256:"), true);
assert(first.candidates.some((row) => row.category === "duplicate"));
assert(first.candidates.some((row) => row.category === "stale"));
assert(first.candidates.some((row) => row.category === "conflict"));
assert(first.candidates.some((row) => row.category === "supersession"));
assert(first.candidates.some((row) => row.category === "orphan-backlink"));
assert(first.candidates.some((row) => row.category === "orphan-evidence"));
assert(first.candidates.some((row) => row.category === "evidence-consistency"));
assert(first.candidates.some((row) => row.category === "retention"));
assert(first.candidates.some((row) => row.category === "permission"));
assert(first.candidates.some((row) => row.category === "cache-consistency"));
assert(first.accounting.counts.new > 0);
assert.equal(first.accounting.applied.status, "insufficient-data");
assert.equal(first.accounting.ignored.status, "insufficient-data");
assert.equal(first.stageMetrics.modelCalls, 0);
assert.equal(JSON.stringify(first).includes(sentinel), false, "maintenance report omits source bodies");
assert.equal(JSON.stringify(first).includes("PRIVATE_DECISION_REASON"), false, "maintenance report hashes free-form decision reasons");
assert.equal(JSON.stringify(first).includes(cwd), false, "maintenance report omits full paths");
assert.equal(fs.statSync(path.join(cwd, first.storage.relativePath)).mode & 0o777, 0o600, "preview report is private");
assert.deepEqual(treeState(path.join(cwd, ".pi"), (file) => file.startsWith(maintenanceRoot)), before, "preview mutates only its private report root");

const second = adapter.preview(options);
assert.equal(second.reportId, first.reportId, "unchanged preview identity is stable");
assert.equal(second.accounting.counts.new, 0);
assert.equal(second.accounting.counts.persistent, second.candidateCount);
assert.equal(second.accounting.counts.resolved, 0);
assert.equal(adapter.history({ limit: 10 }).length, 1, "same-timestamp stable previews replace one report file rather than duplicating state");
assert(adapter.history({ limit: 10 }).every((row) => Number.isFinite(row.stageMetrics.durationMs)));

const duplicateId = first.candidates.find((row) => row.category === "duplicate").candidateId;
const resolvedEntries = entries.filter((entry) => entry.id !== "memory-duplicate").map((entry) => entry.id === "memory-a" ? { ...entry, links: {} } : entry);
fs.writeFileSync(memoryFile, JSON.stringify({ entries: resolvedEntries }), { mode: 0o644 });
fs.chmodSync(memoryFile, 0o644);
const third = adapter.preview(options);
assert(third.accounting.resolved.includes(duplicateId), "resolved candidates move out of persistent accounting");
assert(third.accounting.counts.resolved >= 2, "removed duplicate and orphan backlink are reported resolved");

const truncated = adapter.preview({ ...options, maxCandidates: 1, write: false });
assert.equal(truncated.coverage.complete, false);
assert.equal(truncated.coverage.candidateTruncated, true);
assert.equal(truncated.boundaries.reportOnlyWrite, false);
assert.equal(adapter.due(0).due, false);
assert.equal(adapter.due(24, new Date("2026-08-02T12:00:00.000Z")).due, true);
assert.equal(typeof adapter.status().latest.reportId, "string");

const ledgerFile = path.join(evidenceRoot, "evidence.jsonl");
const ledgerBackup = path.join(evidenceRoot, "evidence.backup");
fs.renameSync(ledgerFile, ledgerBackup);
fs.symlinkSync(path.join(cwd, "outside-evidence.jsonl"), ledgerFile);
fs.writeFileSync(path.join(cwd, "outside-evidence.jsonl"), `${JSON.stringify({ id: "PRIVATE_SYMLINK_EVIDENCE" })}\n`);
const symlinkPreview = adapter.preview({ ...options, write: false });
assert.equal(symlinkPreview.coverage.complete, false);
assert(symlinkPreview.coverage.unavailableProviders.includes("evidence-index"));
assert.equal(JSON.stringify(symlinkPreview).includes("PRIVATE_SYMLINK_EVIDENCE"), false, "maintenance never follows state symlinks");
fs.unlinkSync(ledgerFile);
fs.renameSync(ledgerBackup, ledgerFile);

const unsafeCwd = tmpFixture("memory-maintenance-symlink-root-");
const externalState = tmpFixture("memory-maintenance-external-");
fs.symlinkSync(externalState, path.join(unsafeCwd, ".pi"));
assert.throws(() => new MemoryMaintenanceAdapter({ cwd: unsafeCwd }), /non-symlinked project state path/);

console.log("memory maintenance tests passed");
