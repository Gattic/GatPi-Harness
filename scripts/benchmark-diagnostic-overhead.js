#!/usr/bin/env node
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const { EntropyAdapter, MemoryJsonStorage, FileIntegrationStorage } = require("../src/integration-boundary");
const { hash, percentile } = require("../src/reviewed-evidence");

function benchmark({ cwd = process.cwd(), samples = 200, warmup = 20 } = {}) {
  if (!Number.isInteger(samples) || samples < 20 || samples > 1000) throw new Error("samples must be between 20 and 1000");
  const parent = path.join(cwd, ".pi"); fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stat = fs.statfsSync(parent); if (stat.bavail * stat.bsize < 32 * 1024 * 1024) throw new Error("32 MiB free disk required");
  const directory = fs.mkdtempSync(path.join(parent, "diagnostic-overhead-"));
  const controls = [], candidates = [], deltas = [];
  try {
    const control = new EntropyAdapter({ storage: new MemoryJsonStorage(), options: { persistence: false } });
    const candidate = new EntropyAdapter({ storage: new FileIntegrationStorage(directory) });
    const observe = (adapter, event) => { const start = performance.now(); adapter.observe(event); return performance.now() - start; };
    const timestamp = new Date().toISOString();
    for (let i = 0; i < samples + warmup; i++) {
      const event = { type: "tool_call", tool: "fixture-read", text: "diagnostic persistence benchmark fixture", at: timestamp };
      let a, b;
      if (i % 2) { b = observe(candidate, event); a = observe(control, event); } else { a = observe(control, event); b = observe(candidate, event); }
      if (i >= warmup) { controls.push(a); candidates.push(b); deltas.push(b - a); }
    }
    const stats = values => ({ p95Ms: percentile(values), meanMs: values.reduce((a, b) => a + b, 0) / values.length });
    return { schemaVersion: 1, evidenceClass: "deterministic-fixture", fieldEvidence: false, scope: "entropy observations and private persistence; excludes task-finalization review writes and unrelated tracing", samples, warmup, generatedAt: new Date().toISOString(), sourceHash: hash([__filename, path.join(__dirname, "../src/integration-boundary.js"), path.join(__dirname, "../src/entropy-monitor.js"), path.join(__dirname, "../src/file-integration-storage.js")].map(file => fs.readFileSync(file, "utf8"))), environment: { node: process.version, platform: process.platform, cpuModel: os.cpus()[0]?.model }, controlPersistenceDisabled: stats(controls), candidatePrivatePersistence: stats(candidates), pairedPersistenceIncrement: stats(deltas), perObservationBudgetMs: 10, budgetMet: percentile(candidates) <= 10, fieldObservationTimeShare: null, interventionsAuthorized: false };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
if (require.main === module) {
  try {
    const report = benchmark();
    new FileIntegrationStorage(path.join(process.cwd(), ".pi", "entropy-review")).writeJson("overhead", report);
    console.log(JSON.stringify(report, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { benchmark };
