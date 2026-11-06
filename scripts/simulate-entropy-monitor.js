#!/usr/bin/env node
"use strict";

const path = require("node:path");
const os = require("node:os");
const { EntropyMonitor } = require("../src/entropy-monitor");

function runScenario(name, events) {
  const monitor = new EntropyMonitor({ allowedTools: ["read", "bash", "edit", "write"], persistenceOptions: { dir: path.join(os.tmpdir(), `pi-entropy-${name}`) } });
  let last;
  for (const e of events) last = monitor.observe(e);
  const dashboard = monitor.dashboards(path.join(os.tmpdir(), `pi-entropy-${name}`, "dashboard.html"));
  return { name, entropy: last.metrics.entropyScore, stability: last.metrics.stabilityScore, coherence: last.metrics.coherenceScore, confidence: last.metrics.confidenceScore, status: last.stabilization.status, actions: last.stabilization.actions.map((a) => a.type), dashboard: dashboard.html };
}

const stable = [
  { type: "objective", text: "Add focused unit tests" },
  { type: "context", tokens: 800 },
  { type: "plan", text: "Implement test then run verifier" },
  { type: "patch", ok: true, patch: "test change" },
  { type: "verifier", ok: true, verifier: "unit" },
  { type: "progress", ok: true, text: "tests passed" },
];

const runaway = [{ type: "objective", text: "Fix entropy regression" }, { type: "context", tokens: 1000 }];
for (let i = 0; i < 20; i++) runaway.push(
  { type: "context", tokens: 1000 + i * 2500 },
  { type: "retry", ok: false, error: "same failing verifier", retryDepth: i + 1 },
  { type: "patch", ok: false, status: "rollback", patch: `A${i % 2}` },
  { type: "verifier", ok: false, verifier: "unit", error: "same failing verifier" },
);
runaway.push({ type: "assumption", text: "Use durable persistence" }, { type: "assumption", text: "Do not use durable persistence" }, { type: "tool_call", tool: "imaginary" });

const divergent = [
  { type: "objective", text: "Maintain long session coherence" },
  { type: "branch", branchId: "a", objective: "compact context and prune stale notes", files: ["src/context.js"] },
  { type: "branch", branchId: "b", objective: "rewrite payment architecture", files: ["src/payments.js"] },
  { type: "branch", branchId: "c", objective: "debug CSS rendering", files: ["styles/app.css"] },
];

console.log(JSON.stringify([runScenario("stable", stable), runScenario("runaway", runaway), runScenario("divergent", divergent)], null, 2));
