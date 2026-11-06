"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EntropyMonitor,
  ContradictionDetector,
  RecursiveFailureDetector,
  ContextSanitizer,
  EntropyDashboard,
  MetricsPersistence,
  summarizeSnapshots,
} = require("../src/entropy-monitor");
const { tmpFixture } = require("./helpers/tmp-fixture");

(() => {
  const detector = new ContradictionDetector();
  assert.equal(detector.observe({ type: "assumption", text: "Use SQLite mirror for trace persistence" }).length, 0);
  const conflicts = detector.observe({ type: "assumption", text: "Do not use SQLite mirror for trace persistence" });
  assert(conflicts.some((c) => c.type === "conflicting-assumption"), "opposite assumptions are detected");
  detector.observe({ type: "plan", text: "Add entropy dashboard" });
  const planConflicts = detector.observe({ type: "plan", text: "Remove entropy dashboard" });
  assert(planConflicts.some((c) => c.type === "conflicting-plan"), "opposing plans are detected");
  detector.observe({ type: "objective", text: "Implement durable entropy monitoring dashboard" });
  const dups = detector.observe({ type: "objective", text: "Implement durable entropy monitoring dashboard" });
  assert(dups.some((c) => c.type === "duplicated-objective"), "duplicated objectives are detected");
})();

(() => {
  const loop = new RecursiveFailureDetector();
  for (let i = 0; i < 7; i++) {
    loop.observe({ type: "retry", ok: false, error: "unit verifier failed: same assertion" });
    loop.observe({ type: "plan", text: "try same patch again" });
  }
  const analysis = loop.analyze();
  assert(analysis.score > 0.5, "recursive failed retries produce high loop score");
  assert(analysis.failedRetries >= 7);
})();

(() => {
  const sanitizer = new ContextSanitizer({ clock: () => 10_000_000 });
  const result = sanitizer.sanitize([
    { id: "arch", title: "Invariant", content: "Verification is mandatory", tags: ["architecture"], updatedAt: 0 },
    { id: "stale", title: "Old scratch", content: "temporary", updatedAt: 0 },
    { id: "spec", title: "Maybe", content: "speculative branch", speculative: true, updatedAt: 9_999_999 },
    { id: "dup1", title: "Same", content: "repeat repeat repeat", updatedAt: 9_999_999 },
    { id: "dup2", title: "Same", content: "repeat repeat repeat", updatedAt: 9_999_999 },
  ], { maxAgeMs: 1000 });
  assert(result.kept.some((b) => b.id === "arch"), "protected architecture context survives stale pruning");
  assert(result.removed.some((b) => b.id === "stale"), "stale context is pruned");
  assert(result.isolated.some((b) => b.id === "spec"), "speculative context is isolated");
  assert(result.removed.some((b) => b.id === "dup2"), "redundancy is removed");
})();

(() => {
  const tmp = tmpFixture("pi-entropy-");
  let t = Date.now(); // Persisted diagnostics now expire by wall-clock age.
  const monitor = new EntropyMonitor({
    clock: () => (t += 1000),
    allowedTools: ["read", "bash", "edit", "write"],
    persistenceOptions: { dir: tmp },
  });

  monitor.observe({ type: "objective", text: "Implement entropy monitoring for stable sessions", tokens: 20 });
  monitor.observe({ type: "context", tokens: 1000 });
  monitor.observe({ type: "assumption", text: "Use deterministic local scoring" });
  monitor.observe({ type: "assumption", text: "Do not use deterministic local scoring" });
  monitor.observe({ type: "tool_call", tool: "fakeTool" });
  for (let i = 0; i < 6; i++) {
    monitor.observe({ type: "patch", ok: false, status: "rollback", patch: `change ${i % 2}`, retryDepth: i + 1 });
    monitor.observe({ type: "verifier", verifier: "unit", ok: false, error: "same failure", retryDepth: i + 1 });
  }
  monitor.observe({ type: "branch", branchId: "a", objective: "fix tests in entropy monitor", files: ["src/entropy-monitor.js"] });
  const snapshot = monitor.observe({ type: "branch", branchId: "b", objective: "rewrite unrelated database layer", files: ["src/db.js"] });

  assert(snapshot.metrics.entropyScore > 0.35, "entropy score rises under failures");
  assert(snapshot.metrics.stabilityScore < 0.8, "stability score responds to entropy");
  assert(snapshot.metrics.coherenceScore < 1, "coherence score responds to contradictions/divergence");
  assert(snapshot.stabilization.actions.length > 0, "auto-stabilization recommends actions");
  assert(snapshot.stabilization.actions.some((a) => ["request_failure_analysis", "isolate_failing_agents", "compact_context"].includes(a.type)));
  assert(fs.existsSync(path.join(tmp, "events.jsonl")), "events are persisted");
  assert(fs.existsSync(path.join(tmp, "snapshots.jsonl")), "snapshots are persisted");

  const dashboards = monitor.dashboards(path.join(tmp, "dashboard.html"));
  assert(dashboards.ascii.entropy.length > 0, "ASCII entropy timeline is produced");
  assert(fs.existsSync(dashboards.html), "HTML dashboard is produced");

  const persistence = new MetricsPersistence({ dir: tmp });
  const persisted = persistence.loadSnapshots(5);
  assert(persisted.length > 0, "persisted snapshots can be loaded");
  const stats = summarizeSnapshots(persisted);
  assert.equal(stats.count, persisted.length);
})();

console.log("entropy-monitor tests passed");
