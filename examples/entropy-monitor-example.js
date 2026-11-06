"use strict";

const path = require("node:path");
const os = require("node:os");
const { EntropyMonitor } = require("../src/entropy-monitor");

const monitor = new EntropyMonitor({
  allowedTools: ["read", "bash", "edit", "write"],
  persistenceOptions: { dir: path.join(os.tmpdir(), "pi-entropy-example") },
});

monitor.observe({ type: "objective", text: "Implement entropy monitoring while preserving verifier-gated architecture" });
monitor.observe({ type: "context", tokens: 1200 });
monitor.observe({ type: "assumption", text: "Use deterministic local metrics" });
monitor.observe({ type: "plan", text: "Add dashboard and tests" });
monitor.observe({ type: "patch", ok: true, patch: "src/entropy-monitor.js" });
monitor.observe({ type: "verifier", verifier: "unit", ok: true, tokens: 200 });

// Simulate drift and recursive failures.
monitor.observe({ type: "assumption", text: "Do not use deterministic local metrics" });
for (let i = 0; i < 4; i++) {
  monitor.observe({ type: "retry", ok: false, error: "same verifier failure", retryDepth: i + 1 });
  monitor.observe({ type: "patch", ok: false, status: "rollback", patch: `unstable-${i % 2}` });
}
monitor.observe({ type: "tool_call", tool: "nonexistent_tool" });
monitor.observe({ type: "branch", branchId: "main", objective: "stabilize entropy monitor", files: ["src/entropy-monitor.js"] });
const latest = monitor.observe({ type: "branch", branchId: "side", objective: "unrelated UI rewrite", files: ["src/ui.js"] });

console.log(JSON.stringify({
  health: latest.stabilization.status,
  entropy: latest.metrics.entropyScore,
  stability: latest.metrics.stabilityScore,
  coherence: latest.metrics.coherenceScore,
  confidence: latest.metrics.confidenceScore,
  actions: latest.stabilization.actions,
  dashboard: monitor.dashboards().html,
}, null, 2));
